/**
 * Human-user authentication: JWT access tokens (short-lived, stateless)
 * plus server-side refresh tokens (long-lived, revocable, rotation with
 * reuse detection).
 *
 *   - access token:  HS256 JWT, default 15 min, carries userId + username
 *   - refresh token: random 256-bit value; only its SHA-256 is stored in
 *     `refresh_tokens`; every refresh rotates it and revokes the previous
 *     one. Reusing a revoked token revokes the whole chain (theft signal).
 *
 * Device auth is intentionally different: per-session stateful MQTT
 * authentication (see broker), never JWT.
 */

import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "../db";

export interface JwtConfig {
  /** HS256 secret (>= 32 bytes recommended). */
  secret: string;
  /** Access token lifetime in seconds. */
  accessTtlSeconds: number;
  /** Refresh token lifetime in seconds. */
  refreshTtlSeconds: number;
}

export interface AccessTokenPayload {
  sub: string; // user id
  username: string;
}

export class AuthError extends Error {
  constructor(
    public readonly kind:
      | "invalid_credentials"
      | "invalid_token"
      | "token_expired"
      | "token_revoked"
      | "reuse_detected",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Audience for human access tokens (audit M5: separates token classes). */
export const ACCESS_TOKEN_AUDIENCE = "soulcloud-api";

/** Signs a short-lived access token. */
export async function signAccessToken(
  config: JwtConfig,
  payload: AccessTokenPayload,
): Promise<string> {
  const key = new TextEncoder().encode(config.secret);
  return new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSeconds}s`)
    .sign(key);
}

/** Verifies an access token; returns the payload. */
export async function verifyAccessToken(
  config: JwtConfig,
  token: string,
): Promise<AccessTokenPayload> {
  try {
    const key = new TextEncoder().encode(config.secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
      throw new AuthError("invalid_token", "malformed token payload");
    }
    return { sub: payload.sub, username: payload.username };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if ((error as { code?: string }).code === "ERR_JWT_EXPIRED") {
      throw new AuthError("token_expired", "access token expired");
    }
    throw new AuthError("invalid_token", "invalid access token");
  }
}

/** Generates a refresh token and stores its SHA-256. */
export async function issueRefreshToken(
  prisma: PrismaClient,
  userId: string,
  config: JwtConfig,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
    },
  });
  return token;
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Rotates a refresh token: verifies it, revokes it, issues a new pair.
 * Reuse of an already-revoked token revokes the whole chain.
 */
export async function rotateRefreshToken(
  prisma: PrismaClient,
  config: JwtConfig,
  refreshToken: string,
): Promise<RotatedTokens> {
  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, username: true } } },
  });

  if (!stored) {
    throw new AuthError("invalid_token", "unknown refresh token");
  }
  if (stored.expiresAt.getTime() < Date.now()) {
    // expiry is terminal; mark revoked (best effort) and reject
    await prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AuthError("token_expired", "refresh token expired");
  }

  // M1: atomic rotation. Only the first concurrent refresh wins the
  // conditional update; a loser is either a replay (theft signal) or a
  // concurrent refresh — both revoke the ENTIRE user session family
  // (H2: chain-walking only reached depth 1; revoking by user closes the
  // gap at any depth and forces a re-login, which is the clearest
  // semantics for a stolen-token signal).
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count === 0) {
    await revokeAllForUser(prisma, stored.userId);
    throw new AuthError("reuse_detected", "refresh token reuse detected");
  }

  // revoke this token, issue the successor
  const nextToken = randomBytes(32).toString("base64url");
  await prisma.refreshToken.create({
    data: {
      userId: stored.userId,
      tokenHash: hashToken(nextToken),
      expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
      rotatedFrom: stored.id,
    },
  });

  return {
    accessToken: await signAccessToken(config, {
      sub: stored.user.id,
      username: stored.user.username,
    }),
    refreshToken: nextToken,
  };
}

/** Revokes a refresh token (logout). */
export async function revokeRefreshToken(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Revokes EVERY active refresh token of the user (reuse detection, H2).
 * Chain-walking only ever reached depth 1; revoking by user id closes the
 * gap at any chain depth and forces a full re-login — the clearest
 * semantics for a stolen-token signal.
 */
async function revokeAllForUser(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
