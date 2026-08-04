import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  API_BIND_ADDRESS: z.string().default("0.0.0.0:8080"),
  // JWT auth (G group): a production deployment MUST set a strong secret
  JWT_SECRET: z.string().min(32).default("dev-only-secret-change-me-0123456789"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
});

export type ApiConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadApiConfig(): ApiConfig {
  return loadEnv(envSchema);
}
