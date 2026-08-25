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
import { createSigner, createVerifier, TOKEN_ERROR_CODES } from "fast-jwt";
import { Prisma, type PrismaClient } from "../db";

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

/**
 * Signers and verifiers are cached per JWT secret (the secret is fixed for
 * the process lifetime; tests inject their own). The signer's expiresIn is
 * baked in at creation, so the signer key must include the TTL (a caller
 * asking for a different TTL must not silently reuse another one). The
 * verifier enables fast-jwt's verified-token LRU cache (default
 * sha256-keyed, so raw tokens are never retained in memory): a 15-minute
 * access token is re-verified on every API/WS request, and the cache skips
 * the repeated HMAC work. Cache entries respect the token's own `exp`, so
 * a cached hit can never outlive the token.
 *
 * Types: fast-jwt's `createSigner`/`createVerifier` overload on the key
 * style (sync key -> sync function, async key fetcher -> async function);
 * `ReturnType` resolves to the LAST (async) overload, so the sync shapes
 * are declared explicitly here.
 */
type AccessTokenSigner = (payload: Record<string, unknown>) => string;
type AccessTokenVerifier = (token: string) => unknown;

const signers = new Map<string, AccessTokenSigner>();
const verifiers = new Map<string, AccessTokenVerifier>();

/** Verifier LRU size (fast-jwt `cache: true` equals 1000). */
const VERIFIER_CACHE_SIZE = 1000;

function getSigner(config: JwtConfig): AccessTokenSigner {
  const cacheKey = `${config.secret}:${config.accessTtlSeconds}`;
  let signer = signers.get(cacheKey);
  if (!signer) {
    signer = createSigner({
      key: config.secret,
      algorithm: "HS256",
      // fast-jwt interprets numeric expiresIn as MILLISECONDS (verified
      // against the source: exp = (iat + expiresIn) / 1000; the README's
      // "seconds" claim is outdated)
      expiresIn: config.accessTtlSeconds * 1000,
      aud: ACCESS_TOKEN_AUDIENCE,
    });
    signers.set(cacheKey, signer);
  }
  return signer;
}

function getVerifier(config: JwtConfig): AccessTokenVerifier {
  // the cacheTTL is baked in at creation, so the key includes the TTL
  // (same reasoning as the signer)
  const cacheKey = `${config.secret}:${config.accessTtlSeconds}`;
  let verifier = verifiers.get(cacheKey);
  if (!verifier) {
    verifier = createVerifier({
      key: config.secret,
      algorithms: ["HS256"],
      allowedAud: ACCESS_TOKEN_AUDIENCE,
      // fast-jwt skips allowedAud when the token has NO aud claim (unlike
      // jose, which treated aud as required). Making aud/exp required
      // restores the jose semantics: a token without an audience (or
      // without expiry) is rejected.
      requiredClaims: ["aud", "exp"],
      cache: VERIFIER_CACHE_SIZE,
      // entries never outlive the token itself: `exp` (or a shorter
      // cacheTTL) bounds every cached verification
      cacheTTL: config.accessTtlSeconds * 1000,
    });
    verifiers.set(cacheKey, verifier);
  }
  return verifier;
}

/** Signs a short-lived access token. */
export async function signAccessToken(
  config: JwtConfig,
  payload: AccessTokenPayload,
): Promise<string> {
  return getSigner(config)({ sub: payload.sub, username: payload.username });
}

/** Verifies an access token; returns the payload. */
export async function verifyAccessToken(
  config: JwtConfig,
  token: string,
): Promise<AccessTokenPayload> {
  try {
    const payload = getVerifier(config)(token) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
      throw new AuthError("invalid_token", "malformed token payload");
    }
    return { sub: payload.sub, username: payload.username };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if ((error as { code?: string }).code === TOKEN_ERROR_CODES.expired) {
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
  // M1: keep claim, successor creation and reuse-family revocation in one
  // transaction. Otherwise a losing concurrent request can revoke the
  // family before the winner inserts its successor, leaving that successor
  // usable despite the detected reuse.
  const outcome = await prisma.$transaction(async (tx) => {
    const stored = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, username: true } } },
    });
    if (!stored) return { kind: "invalid" as const };
    if (stored.expiresAt.getTime() < Date.now()) {
      await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: "expired" as const };
    }

    const claimed = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      // H2: chain-walking only reached depth 1; revoking by user closes the
      // gap at any chain depth and forces a full re-login.
      await revokeAllForUser(tx, stored.userId);
      return { kind: "reuse" as const };
    }

    const nextToken = randomBytes(32).toString("base64url");
    await tx.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashToken(nextToken),
        expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
        rotatedFrom: stored.id,
      },
    });
    return { kind: "success" as const, nextToken, userId: stored.user.id, username: stored.user.username };
  });

  if (outcome.kind === "invalid") throw new AuthError("invalid_token", "unknown refresh token");
  if (outcome.kind === "expired") throw new AuthError("token_expired", "refresh token expired");
  if (outcome.kind === "reuse") throw new AuthError("reuse_detected", "refresh token reuse detected");
  return {
    accessToken: await signAccessToken(config, { sub: outcome.userId, username: outcome.username }),
    refreshToken: outcome.nextToken,
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
async function revokeAllForUser(prisma: PrismaClient | Prisma.TransactionClient, userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
