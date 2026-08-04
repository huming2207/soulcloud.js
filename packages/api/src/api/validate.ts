/**
 * Shared request-validation helpers for the API.
 *
 * Elysia 1.4's onError hook is unreliable under Bun, so every handler wraps
 * its logic with `handleApiError` which maps unknown failures to a uniform
 * `500 { error: "internal" }` without leaking internal messages. All path
 * and query parameters are validated with Zod before use.
 */

import { z } from "zod";

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
