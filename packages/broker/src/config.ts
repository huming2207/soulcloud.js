import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  /// HS256 secret for OTA download JWTs (must match the API process)
  JWT_SECRET: z.string().min(32).default("dev-only-secret-change-me-0123456789"),
  MQTT_BROKER_PORT: z.coerce.number().int().positive().default(1883),
  /// WebSocket path for MQTT (reverse proxy terminates TLS in front of this)
  MQTT_BROKER_PATH: z.string().startsWith("/").default("/mqtt"),
  MQTT_COMMAND_RETAIN: z
    .string()
    .transform((v) => v === "true")
    .default(false),
  COMMAND_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  COMMAND_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  // OTA delivery:
  OTA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OTA_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /// Download JWT lifetime in seconds (minted at publish time)
  OTA_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  // Uplink ingestion protection (DDoS / misbehaving devices):
  UPLINK_MAX_PACKET_BYTES: z.coerce.number().int().positive().default(65536),
  UPLINK_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),
  UPLINK_RATE_BURST: z.coerce.number().int().positive().default(100),
});

export type BrokerConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadBrokerConfig(): BrokerConfig {
  return loadEnv(envSchema);
}
