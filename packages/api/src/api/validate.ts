/**
 * Shared request-validation helpers for the API.
 *
 * Elysia 1.4's onError hook is unreliable under Bun, so every handler wraps
 * its logic with `handleApiError` which maps unknown failures to a uniform
 * `500 { error: "internal" }` without leaking internal messages. All path
 * and query parameters are validated with Zod before use.
 */

import { z } from "zod";
import {
  verifyAccessToken,
  type AccessTokenPayload,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";

/** UUID path/query parameter. */
export const UuidParam = z.string().uuid();

/** Cursor for log pagination (raw_log_events.id, a positive bigint). */
export const CursorParam = z
  .string()
  .regex(/^\d+$/, "cursor must be a positive integer")
  .transform(BigInt)
  .refine((v) => v > 0n, "cursor must be positive");

/** Page size with a hard cap. */
export const LimitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(500);

/** Offset for offset-paginated lists (devices, jobs, rollouts). */
export const OffsetParam = z.coerce.number().int().min(0);

/** Standard error response shape. */
export interface ApiErrorResponse {
  error: string;
  message: string;
}

/**
 * Wraps a handler so unexpected errors become a uniform 500 without
 * leaking internals; typed errors (CommandQueueError etc.) are mapped by
 * the caller's own switch before falling through here.
 */
export function handleApiError(
  error: unknown,
  set: { status?: number | string },
): ApiErrorResponse {
  console.error(`[soulcloud-api] internal error: ${(error as Error).stack ?? (error as Error).message}`);
  set.status = 500;
  return { error: "internal", message: "internal server error" };
}

/** Parses a query parameter with a schema, setting a 400 response on failure. */
export function parseQueryParam<T>(
  schema: z.ZodType<T>,
  raw: string | undefined,
  set: { status?: number | string },
  name: string,
): T | null {
  if (raw === undefined) return null;
  const result = schema.safeParse(raw);
  if (!result.success) {
    set.status = 400;
    return null;
  }
  return result.data;
}


/**
 * Short-TTL caches for the two per-request DB lookups.
 *
 * Elysia 1.4 runs a WS route's beforeHandle TWICE on a successful
 * handshake (compose chain + adapter - documented in
 * docs/en/undocumented-api-dependencies.md E5), and REST clients batch
 * requests under one user. Caching the user/membership lookups for a few
 * seconds absorbs both without weakening authorization meaningfully: the
 * access token is stateless for 15 minutes anyway, and a deleted user or
 * removed membership still takes effect within the TTL.
 */
const AUTH_CACHE_TTL_MS = 5_000;
const AUTH_CACHE_MAX_ENTRIES = 10_000;

const userCache = new Map<string, { user: { id: string; username: string }; expiresAt: number }>();
const membershipCache = new Map<string, { expiresAt: number }>();

function cacheGet<T>(cache: Map<string, T & { expiresAt: number }>, key: string): (Omit<T, "expiresAt">) | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // return a copy of the stored value: the cache entry stays private so
  // no caller can accidentally mutate the shared object
  const { expiresAt: _expiresAt, ...rest } = entry;
  void _expiresAt;
  return rest;
}

function cacheSet<T extends { expiresAt: number }>(cache: Map<string, T>, key: string, value: Omit<T, "expiresAt">): void {
  if (cache.size >= AUTH_CACHE_MAX_ENTRIES) {
    // evict ONE arbitrary entry instead of clear()-ing everything: a
    // clear at the cap makes the hit rate collapse exactly when the
    // cache is most useful (large active user set)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ...value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS } as T);
}

/**
 * Extracts the Bearer access token from a request; returns null when absent
 * or invalid (the caller decides the status mapping).
 */
export async function authenticateRequest(
  prisma: PrismaClient,
  jwt: JwtConfig,
  request: Request,
): Promise<{ user: { id: string; username: string } } | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  let payload: AccessTokenPayload;
  try {
    payload = await verifyAccessToken(jwt, token);
  } catch {
    return null;
  }
  // short-TTL cache keyed by user id: the signature was just verified, so
  // the cached row is only reused for the same user within the TTL window
  const cached = cacheGet(userCache, payload.sub);
  if (cached) return cached;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true },
  });
  if (!user) return null;
  cacheSet(userCache, payload.sub, { user });
  return { user };
}

/** Checks that a user can access a project (personal project membership). */
export async function userCanAccessProject(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const key = `${userId}:${projectId}`;
  const cached = cacheGet(membershipCache, key);
  if (cached) return true;
  const link = await prisma.userProject.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { userId: true },
  });
  if (!link) return false;
  cacheSet(membershipCache, key, {});
  return true;
}
