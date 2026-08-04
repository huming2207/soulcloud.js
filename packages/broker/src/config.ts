import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  MQTT_BROKER_PORT: z.coerce.number().int().positive().default(1883),
  /// WebSocket path for MQTT (reverse proxy terminates TLS in front of this)
  MQTT_BROKER_PATH: z.string().startsWith("/").default("/mqtt"),
  MQTT_COMMAND_RETAIN: z
    .string()
    .transform((v) => v === "true")
    .default(false),
  COMMAND_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  COMMAND_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  // Uplink ingestion protection (DDoS / misbehaving devices):
  UPLINK_MAX_PACKET_BYTES: z.coerce.number().int().positive().default(65536),
  UPLINK_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),
  UPLINK_RATE_BURST: z.coerce.number().int().positive().default(100),
});

export type BrokerConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadBrokerConfig(): BrokerConfig {
  return loadEnv(envSchema);
}
