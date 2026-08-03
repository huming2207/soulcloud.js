import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  MQTT_BROKER_PORT: z.coerce.number().int().positive().default(1883),
  MQTT_COMMAND_RETAIN: z
    .string()
    .transform((v) => v === "true")
    .default(false),
  COMMAND_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  COMMAND_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
});

export type BrokerConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadBrokerConfig(): BrokerConfig {
  return loadEnv(envSchema);
}
