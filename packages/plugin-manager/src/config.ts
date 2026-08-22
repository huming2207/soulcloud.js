import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";

const envSchema = z.object({
  ...SharedEnv,
  PLUGIN_ENDPOINTS: z.string().default(""),
  PLUGIN_MANAGER_INTERNAL_BIND: z.string().default("127.0.0.1"),
  PLUGIN_MANAGER_INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8091),
  PLUGIN_MANAGER_SERVICE_TOKEN: z.string().min(16),
  PLUGIN_RPC_MAX_FRAME_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  PLUGIN_RPC_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(128),
  PLUGIN_RPC_BACKPRESSURE_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
  PLUGIN_RPC_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  PLUGIN_MANAGER_RECONNECT_MS: z.coerce.number().int().positive().default(2_000),
});

export type PluginManagerConfig = BaseConfig & z.infer<typeof envSchema>;
export function loadPluginManagerConfig(): PluginManagerConfig { return loadEnv(envSchema); }

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
