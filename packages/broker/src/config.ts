import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  /// HS256 secret for OTA download JWTs. REQUIRED, no default; MUST match
  /// the API process's JWT_SECRET (set in .env).
  JWT_SECRET: z.string().min(32),
  MQTT_BROKER_PORT: z.coerce.number().int().positive().default(1883),
  /// WebSocket path for MQTT (reverse proxy terminates TLS in front of this)
  MQTT_BROKER_PATH: z.string().startsWith("/").default("/mqtt"),
  MQTT_COMMAND_RETAIN: z
    .string()
    .transform((v) => v === "true")
    .default(false),
  /// Max concurrent Argon2id device-auth verifications. Keeps a reconnect
  /// burst (or a hostile device farm) from pinning every core on CPU-bound
  /// password hashing; excess attempts queue (bounded) instead of failing.
  BROKER_AUTH_CONCURRENCY: z.coerce.number().int().positive().default(8),
  COMMAND_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  COMMAND_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /// Delivery-deadline expiry sweep cadence (independent of the drain
  /// poll; deadlines need seconds of precision, not 500ms UPDATEs).
  COMMAND_EXPIRE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // OTA delivery:
  OTA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OTA_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /// OTA expiry maintenance cadence (targets + stall sweeps).
  OTA_EXPIRE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /// Download JWT lifetime in seconds (minted at publish time)
  OTA_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  /// A delivered/delivering/downloaded target that never completes its
  /// download within this window is failed with code -7
  OTA_STALL_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  // Uplink ingestion protection (DDoS / misbehaving devices):
  UPLINK_MAX_PACKET_BYTES: z.coerce.number().int().positive().default(65536),
  UPLINK_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),
  UPLINK_RATE_BURST: z.coerce.number().int().positive().default(100),
  /// Global database-work bounds. Capacity includes running work; it must be
  /// at least concurrency so overload is rejected instead of accumulating.
  UPLINK_WORK_CONCURRENCY: z.coerce.number().int().positive().default(16),
  UPLINK_WORK_CAPACITY: z.coerce.number().int().positive().default(1024),
  /// Total buffered payload bytes across running + queued uplinks (memory
  /// ceiling; a count-only cap could still retain ~256MB of buffers).
  UPLINK_WORK_MAX_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
});

export type BrokerConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadBrokerConfig(): BrokerConfig {
  const config = loadEnv(envSchema);
  if (config && config.UPLINK_WORK_CAPACITY < config.UPLINK_WORK_CONCURRENCY) {
    throw new Error("UPLINK_WORK_CAPACITY must be >= UPLINK_WORK_CONCURRENCY");
  }
  if (config && config.UPLINK_WORK_MAX_BYTES < config.UPLINK_MAX_PACKET_BYTES) {
    throw new Error("UPLINK_WORK_MAX_BYTES must be >= UPLINK_MAX_PACKET_BYTES");
  }
  // MQTT_COMMAND_RETAIN replays the last command to any device that
  // (re)subscribes. Retained state is never cleared and the device-side
  // dedupe cache is small and volatile, so a stale state-changing command
  // could be re-executed after a reboot. Refuse it in production instead
  // of shipping a documented footgun.
  // (config can be undefined only when loadEnv's process.exit was mocked
  // in tests; the real process exits before this line.)
  if (config?.MQTT_COMMAND_RETAIN && process.env.NODE_ENV === "production") {
    throw new Error(
      "MQTT_COMMAND_RETAIN=true is not allowed in production: retained " +
        "command state is never cleared and can replay stale commands. " +
        "Remove the setting or run with NODE_ENV != production.",
    );
  }
  return config;
}
