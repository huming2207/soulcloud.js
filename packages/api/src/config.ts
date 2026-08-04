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
});

export type ApiConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadApiConfig(): ApiConfig {
  return loadEnv(envSchema);
}
