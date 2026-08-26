import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  PLUGIN_ENDPOINTS: z.string().default(""),
  PLUGIN_MANAGER_INTERNAL_BIND: z.string().default("127.0.0.1"),
  PLUGIN_MANAGER_INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8091),
  PLUGIN_MANAGER_SERVICE_TOKEN: z.string().min(16),
  PLUGIN_RPC_AUTH_TOKEN: z.string().min(32),
  PLUGIN_RPC_MAX_FRAME_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(1024 * 1024),
  PLUGIN_RPC_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().max(4096).default(128),
  PLUGIN_MANAGER_MAX_OPERATIONS: z.coerce.number().int().positive().max(4096).default(256),
  PLUGIN_MANAGER_MAX_OPERATIONS_PER_PLUGIN: z.coerce.number().int().positive().max(1024).default(64),
  PLUGIN_MANAGER_MAX_OPERATIONS_PER_INSTALLATION: z.coerce.number().int().positive().max(256).default(32),
  PLUGIN_RPC_MAX_REVERSE_CALLS: z.coerce.number().int().positive().max(1024).default(64),
  PLUGIN_RPC_MAX_PLUGIN_CALL_DEPTH: z.coerce.number().int().positive().max(8).default(4),
  PLUGIN_RPC_MAX_REVERSE_CONCURRENCY: z.coerce.number().int().positive().max(4096).default(256),
  PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_PLUGIN: z.coerce.number().int().positive().max(1024).default(64),
  PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_INSTALLATION: z.coerce.number().int().positive().max(256).default(16),
  PLUGIN_RPC_MAX_STAGED_COMMANDS: z.coerce.number().int().positive().max(1024).default(32),
  PLUGIN_RPC_MAX_STAGED_COMMAND_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(256 * 1024),
  PLUGIN_RPC_MAX_VALUE_DEPTH: z.coerce.number().int().positive().max(128).default(32),
  PLUGIN_RPC_MAX_VALUE_NODES: z.coerce.number().int().positive().max(1_000_000).default(4096),
  PLUGIN_RPC_MAX_ARRAY_ITEMS: z.coerce.number().int().positive().max(1_000_000).default(4096),
  PLUGIN_RPC_MAX_STRING_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(512 * 1024),
  PLUGIN_RPC_MAX_BLOBS: z.coerce.number().int().positive().max(4096).default(16),
  PLUGIN_RPC_MAX_BLOB_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(65_536),
  PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(256 * 1024),
  PLUGIN_RPC_BACKPRESSURE_BYTES: z.coerce.number().int().positive().max(256 * 1024 * 1024).default(4 * 1024 * 1024),
  PLUGIN_RPC_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  PLUGIN_RPC_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  PLUGIN_MANAGER_RECONNECT_MS: z.coerce.number().int().positive().default(2_000),
  PLUGIN_MANAGER_UI_SESSION_SECRET: z.string().min(32).optional(),
  PLUGIN_UI_SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(900).default(300),
  PLUGIN_ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024),
  PLUGIN_ARTIFACT_UPLOAD_TIMEOUT_MS: z.coerce.number().int().positive().max(1_800_000).default(600_000),
  /** Render deadline for one SSR/UI RPC (ui.render, ui.handleAction, ui.asset). */
  PLUGIN_SSR_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(30_000),
  /** Independent SSR concurrency budget; kept separate from the event
   *  consumer and internal API operation limits so one slow page cannot
   *  exhaust them. */
  PLUGIN_SSR_MAX_CONCURRENCY: z.coerce.number().int().positive().max(256).default(8),
  PLUGIN_EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  PLUGIN_EVENT_LEASE_MS: z.coerce.number().int().min(1_000).default(60_000),
  PLUGIN_EVENT_BATCH_SIZE: z.coerce.number().int().positive().max(256).default(32),
  PLUGIN_EVENT_MAX_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
  PLUGIN_EVENT_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(30_000),
  PLUGIN_EVENT_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(5),
  PLUGIN_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  PLUGIN_ENTITY_HISTORY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  PLUGIN_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  PLUGIN_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),
  PLUGIN_RETENTION_MAX_BATCHES: z.coerce.number().int().positive().max(100).default(8),
});

export type PluginManagerConfig = BaseConfig & z.infer<typeof envSchema>;
export function loadPluginManagerConfig(): PluginManagerConfig {
  const config = loadEnv(envSchema);
  if (config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_PLUGIN > config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY) {
    throw new Error("per-plugin reverse concurrency cannot exceed the global limit");
  }
  if (config.PLUGIN_MANAGER_MAX_OPERATIONS_PER_PLUGIN > config.PLUGIN_MANAGER_MAX_OPERATIONS) {
    throw new Error("per-plugin operation limit cannot exceed the global limit");
  }
  if (config.PLUGIN_MANAGER_MAX_OPERATIONS_PER_INSTALLATION > config.PLUGIN_MANAGER_MAX_OPERATIONS_PER_PLUGIN) {
    throw new Error("per-installation operation limit cannot exceed the per-plugin limit");
  }
  if (config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_INSTALLATION > config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_PLUGIN) {
    throw new Error("per-installation reverse concurrency cannot exceed the per-plugin limit");
  }
  if (config.PLUGIN_RPC_MAX_BLOB_BYTES > config.PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES) {
    throw new Error("per-Blob byte limit cannot exceed the total Blob byte limit");
  }
  return config;
}

export function parsePluginEndpoints(raw: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const item of raw.split(",")) {
    const entry = item.trim(); if (!entry) continue;
    const split = entry.indexOf("=");
    if (split <= 0 || split === entry.length - 1) throw new Error(`PLUGIN_ENDPOINTS entry must be plugin-id=url: ${entry}`);
    const id = entry.slice(0, split).trim(); const rawUrl = entry.slice(split + 1).trim();
    if (!id || result.has(id)) throw new Error(`duplicate plugin endpoint: ${id}`);
    const url = new URL(rawUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`plugin endpoint for ${id} must use ws:// or wss://`);
    if (!url.pathname || url.pathname === "/") url.pathname = "/rpc/ws";
    if (url.pathname !== "/rpc/ws") throw new Error(`plugin endpoint for ${id} must end in /rpc/ws`);
    result.set(id, url.toString());
  }
  return result;
}
