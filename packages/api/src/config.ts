import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

export const envSchema = z.object({
  ...SharedEnv,
  API_BIND_ADDRESS: z.string().default("0.0.0.0:8080"),
  // JWT auth (G group): REQUIRED, no default. A production deployment must
  // set a strong secret (>= 32 chars) in .env; the broker process must use
  // the SAME secret (it signs OTA download JWTs with it).
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
  // OTA: delivery window for a pending target before it expires
  OTA_TARGET_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  // Rollout FSM advance loop cadence
  ROLLOUT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /// Global HTTP request-body ceiling passed to Bun.serve (WEB-09). Must
  /// stay above the largest legitimate upload: firmware multipart can reach
  /// ~2x MAX_FIRMWARE_BYTES (64 MiB) before the route-level cap rejects it.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(80 * 1024 * 1024),
  /// Route-level ceiling for non-multipart bodies (JSON APIs). Firmware
  /// uploads are multipart and exempt; this bounds the JSON parse cost that
  /// runs before authentication on body-carrying routes.
  MAX_JSON_BODY_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  /// Public login/registration Argon2 protection. Requests beyond this
  /// simultaneous-work cap receive 429 rather than queueing in memory.
  AUTH_ARGON2_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /// Hard bound for distinct usernames retained by the local failure cache.
  AUTH_LOGIN_FAILURE_CAPACITY: z.coerce.number().int().positive().default(10_000),
  PLUGIN_MANAGER_INTERNAL_URL: z.string().url().default("http://127.0.0.1:8091"),
  PLUGIN_MANAGER_SERVICE_TOKEN: z.string().min(16).optional(),
  PLUGIN_MANAGER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  PLUGIN_MANAGER_UI_SESSION_SECRET: z.string().min(32).optional(),
  PLUGIN_UI_SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(300),
});

export type ApiConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadApiConfig(): ApiConfig {
  return loadEnv(envSchema);
}

// "host:port" (e.g. "0.0.0.0:8080") or "[v6]:port" (e.g. "[::1]:8080")
const BIND_ADDRESS_RE = /^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/;

/**
 * Parses an API_BIND_ADDRESS value ("host:port" or "[v6]:port") into its
 * hostname and numeric port.
 *
 * Returns null for empty or malformed addresses (missing port, extra
 * colons, non-numeric or out-of-range port). Note: whitespace inside the
 * host part (e.g. a leading space) is accepted as part of the hostname,
 * matching the regex behavior of the previous inline parser in index.ts.
 * The port range check (1-65535) is stricter than the old regex, which
 * accepted any `\d+` port, including 0 and >65535.
 */
export function parseBindAddress(addr: string): { hostname: string; port: number } | null {
  if (addr == null || addr.length === 0) return null;
  const match = BIND_ADDRESS_RE.exec(addr);
  if (!match) return null;
  const hostname = match[1] ?? match[3];
  const port = Number(match[2] ?? match[4]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: hostname!, port };
}
