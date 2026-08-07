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
