import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  API_BIND_ADDRESS: z.string().default("0.0.0.0:8080"),
});

export type ApiConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadApiConfig(): ApiConfig {
  return loadEnv(envSchema);
}
