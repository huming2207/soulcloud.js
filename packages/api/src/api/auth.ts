/**
 * Human-user authentication routes (G group).
 *
 *   POST /v1/auth/register  {username, password, email} -> creates the user
 *                            plus a personal project (user_projects)
 *   POST /v1/auth/login     {username, password} -> access + refresh tokens
 *   POST /v1/auth/refresh   {refresh_token} -> rotated token pair
 *   POST /v1/auth/logout    {refresh_token} -> revokes the token
 *
 * Access tokens are short-lived JWTs; refresh tokens are server-side,
 * revocable and rotated on every use (reuse detection revokes the chain).
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  AuthError,
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type JwtConfig,
  type PrismaClient,
  verifyPassword,
} from "@soulcloud/core";
import { handleApiError } from "./validate";

/**
 * Timing equalization (audit M2): when the username does not exist we still
 * run one argon2id verification against this fixed dummy hash so that
 * "user not found" and "wrong password" cost the same — no username
 * enumeration via response timing. The value is public (not a secret).
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$iTSM8f1M2+WEv8Gski5WvW41lwIm7iZt+OioJwx2pyI$XAgkoMq7xhmEvqNnpJRWTFJNqACk9Tnt7wboBK0JEBw";

/** Fixed delay applied to failed authentication attempts (like the broker). */
const AUTH_FAIL_DELAY_MS = 100;

/**
 * In-process login throttling (audit M5 round-5): after
 * LOGIN_MAX_FAILURES consecutive failures for a username, that username is
 * locked for LOGIN_LOCK_SECONDS. In-memory per-instance state — the
 * deployment docs must note that a multi-instance API needs rate limiting
 * at the reverse proxy (this is a cheap local barrier, not a global one).
 */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_SECONDS = 60;
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

/** Returns the remaining lock seconds for a username (0 = not locked). */
function loginLockRemaining(username: string): number {
  const entry = loginFailures.get(username);
  if (!entry) return 0;
  // lockedUntil === 0 means "never locked": the counter must NOT be
  // dropped here (a past check used `lockedUntil <= Date.now()`, which
  // deleted the counter on every request and made the lock impossible)
  if (entry.lockedUntil === 0) return 0;
  if (entry.lockedUntil <= Date.now()) {
    loginFailures.delete(username);
    return 0;
  }
  return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
}

function recordLoginFailure(username: string): void {
  const entry = loginFailures.get(username) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCK_SECONDS * 1000;
    entry.count = 0;
  }
  loginFailures.set(username, entry);
}

function clearLoginFailures(username: string): void {
  loginFailures.delete(username);
}

const RegisterBody = z
  .object({
    username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(8).max(128),
    email: z.string().email().max(254),
  })
  .strict();

const LoginBody = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

const RefreshBody = z
  .object({ refresh_token: z.string().min(1) })
  .strict();

export function createAuthRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1/auth" })
    .post("/register", async ({ body, set }) => {
      try {
        const parsed = RegisterBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid registration payload" };
        }
        const { username, password, email } = parsed.data;
        const passwordHash = await hashPassword(password);
        // create the user and a personal project in one transaction
        const user = await prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: { username, passwordHash, email },
          });
          const project = await tx.project.create({
            data: { name: `${username}'s project` },
          });
          await tx.userProject.create({
            data: { userId: created.id, projectId: project.id },
          });
          return created;
        });
        const refreshToken = await issueRefreshToken(prisma, user.id, jwt);
        const accessToken = await signAccessToken(jwt, { sub: user.id, username: user.username });
        set.status = 201;
        return { user_id: user.id, access_token: accessToken, refresh_token: refreshToken };
      } catch (error) {
        // unique constraint on username/email -> 409
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2002"
        ) {
          set.status = 409;
          return { error: "username_or_email_taken", message: "username or email already registered" };
        }
        return handleApiError(error, set);
      }
    })
    .post("/login", async ({ body, set }) => {
      try {
        const parsed = LoginBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid login payload" };
        }
        // brute-force barrier: a locked username is rejected before any
        // credential work (the fixed delay still applies, no timing signal)
        const locked = loginLockRemaining(parsed.data.username);
        if (locked > 0) {
          await new Promise((r) => setTimeout(r, AUTH_FAIL_DELAY_MS));
          set.status = 401;
          return { error: "invalid_credentials", message: "invalid username or password" };
        }
        const user = await prisma.user.findUnique({
          where: { username: parsed.data.username },
        });
        // timing-equalized credential check: unknown users verify against
        // the dummy hash instead of short-circuiting
        const passwordOk = user
          ? await verifyPassword(parsed.data.password, user.passwordHash)
          : await verifyPassword(parsed.data.password, DUMMY_PASSWORD_HASH);
        if (!user || !passwordOk) {
          // throttle brute force; also masks the timing oracle
          recordLoginFailure(parsed.data.username);
          await new Promise((r) => setTimeout(r, AUTH_FAIL_DELAY_MS));
          set.status = 401;
          return { error: "invalid_credentials", message: "invalid username or password" };
        }
        clearLoginFailures(parsed.data.username);
        const refreshToken = await issueRefreshToken(prisma, user.id, jwt);
        const accessToken = await signAccessToken(jwt, { sub: user.id, username: user.username });
        return { user_id: user.id, access_token: accessToken, refresh_token: refreshToken };
      } catch (error) {
        return handleApiError(error, set);
      }
    })
    .post("/refresh", async ({ body, set }) => {
      try {
        const parsed = RefreshBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid refresh payload" };
        }
        const rotated = await rotateRefreshToken(prisma, jwt, parsed.data.refresh_token);
        return {
          access_token: rotated.accessToken,
          refresh_token: rotated.refreshToken,
        };
      } catch (error) {
        if (error instanceof AuthError) {
          set.status = 401;
          return { error: error.kind, message: error.message };
        }
        return handleApiError(error, set);
      }
    })
    .post("/logout", async ({ body, set }) => {
      try {
        const parsed = RefreshBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid logout payload" };
        }
        await revokeRefreshToken(prisma, parsed.data.refresh_token);
        return { ok: true };
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
