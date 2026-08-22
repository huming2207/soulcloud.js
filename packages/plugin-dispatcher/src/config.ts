/**
 * Plugin dispatcher configuration (zod, following the broker's config
 * conventions). Every timing is configurable: they are deployment
 * parameters, not protocol constants (§10.4 philosophy).
 */

import { SharedEnv, loadEnv, type Config as BaseConfig } from "@soulcloud/core";
import { z } from "zod";
import type { PluginHostReverseHandlers } from "./rpc-client";

const envSchema = z.object({
  ...SharedEnv,
  /// Comma-separated plugin-id=http(s)://host:port mappings. Plugin hosts
  /// are independent containers; Docker/Kubernetes owns their lifecycle.
  PLUGIN_HOST_URLS: z.string().default(""),
  PLUGIN_HOST_ENDPOINTS: z.string().default(""),
  PLUGIN_RPC_TRANSPORT: z.enum(["http-msgpack", "orpc-ws"]).default("orpc-ws"),
  PLUGIN_RPC_MAX_OPERATIONS: z.coerce.number().int().positive().default(64),
  PLUGIN_RPC_MAX_REVERSE_IN_FLIGHT: z.coerce.number().int().positive().default(64),
  PLUGIN_RPC_PER_PLUGIN_REVERSE_IN_FLIGHT: z.coerce.number().int().positive().default(16),
  PLUGIN_RPC_PER_INSTALLATION_REVERSE_IN_FLIGHT: z.coerce.number().int().positive().default(8),
  PLUGIN_RPC_PER_OPERATION_REVERSE_IN_FLIGHT: z.coerce.number().int().positive().default(4),
  PLUGIN_RPC_MAX_REVERSE_CALLS_PER_OPERATION: z.coerce.number().int().positive().default(64),
  PLUGIN_RPC_MAX_STAGED_COMMANDS_PER_OPERATION: z.coerce.number().int().positive().default(16),
  PLUGIN_RPC_MAX_BLOBS: z.coerce.number().int().positive().default(16),
  PLUGIN_RPC_MAX_BLOB_BYTES: z.coerce.number().int().positive().default(65_536),
  PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES: z.coerce.number().int().positive().default(256 * 1024),
  PLUGIN_RPC_MAX_DEPTH: z.coerce.number().int().positive().default(32),
  PLUGIN_RPC_MAX_NODES: z.coerce.number().int().positive().default(4096),
  PLUGIN_RPC_MAX_ARRAY_ITEMS: z.coerce.number().int().positive().default(4096),
  PLUGIN_RPC_MAX_STRING_BYTES: z.coerce.number().int().positive().default(65_536),
  PLUGIN_RPC_BACKPRESSURE_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
  PLUGIN_RPC_MAX_PENDING_REQUESTS: z.coerce.number().int().positive().default(128),
  PLUGIN_RPC_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  PLUGIN_RPC_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(500),
  PLUGIN_RPC_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
  /// Optional bearer token shared by the dispatcher and plugin-host
  /// containers. Keep this in the deployment secret store/.env.
  PLUGIN_HOST_AUTH_TOKEN: z.string().min(16).optional(),
  PLUGIN_EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  PLUGIN_EVENT_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /// Dispatcher-side deadline for one plugin.handleEvent call. A timeout
  /// invalidates the HTTP client; the container runtime owns restart policy.
  PLUGIN_EVENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PLUGIN_EVENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PLUGIN_EVENT_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  PLUGIN_EVENT_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  /// Total in-flight events across all installations.
  PLUGIN_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(16),
  /// In-flight events per installation — the fairness floor (§6.4: one
  /// factory's flood must not starve another).
  PLUGIN_PER_INSTALLATION_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /// Maximum serialized HTTP MessagePack-RPC request/response body shared with hosts.
  PLUGIN_HOST_MAX_FRAME_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  PLUGIN_RPC_MAX_FRAME_BYTES: z.coerce.number().int().positive().optional(),
  /// Rapid-crash circuit: after this many host exits inside the window the
  /// plugin is benched for the cooldown.
  PLUGIN_HOST_CRASH_THRESHOLD: z.coerce.number().int().positive().default(5),
  PLUGIN_HOST_CRASH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PLUGIN_HOST_CRASH_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  /// Lease recovery + installation version sweep cadence.
  PLUGIN_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /// Terminal event and entity-history retention maintenance.
  PLUGIN_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  PLUGIN_EVENT_RETENTION_DAYS: z.coerce.number().positive().default(30),
  PLUGIN_ENTITY_HISTORY_RETENTION_DAYS: z.coerce.number().positive().default(365),
  PLUGIN_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().default(1_000),
  /// Synchronous action-encoding endpoint (API -> dispatcher -> host).
  PLUGIN_DISPATCHER_HTTP_PORT: z.coerce.number().int().min(0).default(8091),
  PLUGIN_DISPATCHER_HTTP_BIND: z.string().default("0.0.0.0"),
  PLUGIN_DISPATCHER_AUTH_TOKEN: z.string().min(16).optional(),
  PLUGIN_ENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export type DispatcherConfig = BaseConfig & z.infer<typeof envSchema>;

export function loadDispatcherConfig(): DispatcherConfig {
  const config = loadEnv(envSchema);
  if (
    config &&
    config.PLUGIN_MAX_IN_FLIGHT < config.PLUGIN_PER_INSTALLATION_CONCURRENCY
  ) {
    throw new Error(
      "PLUGIN_MAX_IN_FLIGHT must be >= PLUGIN_PER_INSTALLATION_CONCURRENCY",
    );
  }
  if (
    config &&
    config.PLUGIN_EVENT_BACKOFF_MAX_MS < config.PLUGIN_EVENT_BACKOFF_BASE_MS
  ) {
    throw new Error(
      "PLUGIN_EVENT_BACKOFF_MAX_MS must be >= PLUGIN_EVENT_BACKOFF_BASE_MS",
    );
  }
  if (config && config.PLUGIN_EVENT_TIMEOUT_MS >= config.PLUGIN_EVENT_LEASE_SECONDS * 1000) {
    throw new Error(
      "PLUGIN_EVENT_TIMEOUT_MS must be < PLUGIN_EVENT_LEASE_SECONDS * 1000 " +
        "(the lease must outlive one attempt so a timed-out host request can be marked failed, not recovered blind)",
    );
  }
  if (
    config &&
    config.PLUGIN_RPC_RECONNECT_MAX_MS < config.PLUGIN_RPC_RECONNECT_BASE_MS
  ) {
    throw new Error(
      "PLUGIN_RPC_RECONNECT_MAX_MS must be >= PLUGIN_RPC_RECONNECT_BASE_MS",
    );
  }
  if (config && config.PLUGIN_RPC_MAX_OPERATIONS < config.PLUGIN_MAX_IN_FLIGHT) {
    throw new Error(
      "PLUGIN_RPC_MAX_OPERATIONS must be >= PLUGIN_MAX_IN_FLIGHT",
    );
  }
  if (
    config &&
    config.PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS >= config.PLUGIN_RPC_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error(
      "PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS must be < PLUGIN_RPC_HEARTBEAT_INTERVAL_MS",
    );
  }
  if (
    config &&
    config.PLUGIN_RPC_MAX_BLOB_BYTES >
      (config.PLUGIN_RPC_MAX_FRAME_BYTES ?? config.PLUGIN_HOST_MAX_FRAME_BYTES)
  ) {
    throw new Error(
      "PLUGIN_RPC_MAX_BLOB_BYTES must be <= the RPC frame limit",
    );
  }
  return config;
}

/** Options for the embeddable dispatcher core (tests construct these directly). */
export interface DispatcherCoreOptions {
  hostUrls: ReadonlyMap<string, string>;
  reverseHandlers?: PluginHostReverseHandlers;
  hostAuthToken?: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
  eventTimeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxInFlight: number;
  perInstallationConcurrency: number;
  maxFrameBytes: number;
  rpcMaxOperations?: number;
  rpcMaxReverseInFlight?: number;
  rpcPerPluginReverseInFlight?: number;
  rpcPerInstallationReverseInFlight?: number;
  rpcPerOperationReverseInFlight?: number;
  rpcMaxReverseCallsPerOperation?: number;
  rpcMaxStagedCommandsPerOperation?: number;
  rpcMaxBlobs?: number;
  rpcMaxBlobBytes?: number;
  rpcMaxTotalBlobBytes?: number;
  rpcMaxDepth?: number;
  rpcMaxNodes?: number;
  rpcMaxArrayItems?: number;
  rpcMaxStringBytes?: number;
  rpcBackpressureBytes?: number;
  rpcMaxPendingRequests?: number;
  rpcHeartbeatIntervalMs?: number;
  rpcHeartbeatTimeoutMs?: number;
  rpcReconnectBaseMs?: number;
  rpcReconnectMaxMs?: number;
  crashThreshold: number;
  crashWindowMs: number;
  crashCooldownMs: number;
  sweepIntervalMs: number;
  retentionIntervalMs?: number;
  eventRetentionMs?: number;
  entityHistoryRetentionMs?: number;
  retentionBatchSize?: number;
  /** HTTP encode endpoint (entry point only; optional for embedders). */
  dispatcherHttpPort?: number;
  dispatcherHttpBind?: string;
  dispatcherAuthToken?: string;
  encodeTimeoutMs?: number;
}

export function parsePluginHostUrls(raw: string, transport: "http-msgpack" | "orpc-ws" = "http-msgpack"): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error(`PLUGIN_HOST_URLS entry must be plugin-id=url: ${trimmed}`);
    }
    const pluginId = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`PLUGIN_HOST_URLS has invalid URL for ${pluginId}`);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      throw new Error(`PLUGIN_HOST_URLS URL for ${pluginId} must use http(s) or ws(s)`);
    }
    if (!pluginId || urls.has(pluginId)) {
      throw new Error(`PLUGIN_HOST_URLS contains duplicate or empty plugin id: ${pluginId}`);
    }
    if (transport === "orpc-ws" && (url.protocol === "http:" || url.protocol === "https:")) {
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (url.pathname === "/" || url.pathname.length === 0) url.pathname = "/rpc/ws";
    } else if ((url.protocol === "ws:" || url.protocol === "wss:") && (url.pathname === "/" || url.pathname.length === 0)) {
      url.pathname = "/rpc/ws";
    }
    urls.set(pluginId, url.toString().replace(/\/$/, ""));
  }
  return urls;
}

export function dispatcherCoreOptionsFromConfig(
  config: DispatcherConfig,
): DispatcherCoreOptions {
  return {
    hostUrls: parsePluginHostUrls(
      config.PLUGIN_HOST_ENDPOINTS || config.PLUGIN_HOST_URLS,
      config.PLUGIN_RPC_TRANSPORT,
    ),
    hostAuthToken: config.PLUGIN_HOST_AUTH_TOKEN,
    pollIntervalMs: config.PLUGIN_EVENT_POLL_INTERVAL_MS,
    leaseDurationMs: config.PLUGIN_EVENT_LEASE_SECONDS * 1000,
    eventTimeoutMs: config.PLUGIN_EVENT_TIMEOUT_MS,
    maxAttempts: config.PLUGIN_EVENT_MAX_ATTEMPTS,
    backoffBaseMs: config.PLUGIN_EVENT_BACKOFF_BASE_MS,
    backoffMaxMs: config.PLUGIN_EVENT_BACKOFF_MAX_MS,
    maxInFlight: config.PLUGIN_MAX_IN_FLIGHT,
    perInstallationConcurrency: config.PLUGIN_PER_INSTALLATION_CONCURRENCY,
    maxFrameBytes: config.PLUGIN_RPC_MAX_FRAME_BYTES ?? config.PLUGIN_HOST_MAX_FRAME_BYTES,
    rpcMaxOperations: config.PLUGIN_RPC_MAX_OPERATIONS,
    rpcMaxReverseInFlight: config.PLUGIN_RPC_MAX_REVERSE_IN_FLIGHT,
    rpcPerPluginReverseInFlight: config.PLUGIN_RPC_PER_PLUGIN_REVERSE_IN_FLIGHT,
    rpcPerInstallationReverseInFlight: config.PLUGIN_RPC_PER_INSTALLATION_REVERSE_IN_FLIGHT,
    rpcPerOperationReverseInFlight: config.PLUGIN_RPC_PER_OPERATION_REVERSE_IN_FLIGHT,
    rpcMaxReverseCallsPerOperation: config.PLUGIN_RPC_MAX_REVERSE_CALLS_PER_OPERATION,
    rpcMaxStagedCommandsPerOperation: config.PLUGIN_RPC_MAX_STAGED_COMMANDS_PER_OPERATION,
    rpcMaxBlobs: config.PLUGIN_RPC_MAX_BLOBS,
    rpcMaxBlobBytes: config.PLUGIN_RPC_MAX_BLOB_BYTES,
    rpcMaxTotalBlobBytes: config.PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES,
    rpcMaxDepth: config.PLUGIN_RPC_MAX_DEPTH,
    rpcMaxNodes: config.PLUGIN_RPC_MAX_NODES,
    rpcMaxArrayItems: config.PLUGIN_RPC_MAX_ARRAY_ITEMS,
    rpcMaxStringBytes: config.PLUGIN_RPC_MAX_STRING_BYTES,
    rpcBackpressureBytes: config.PLUGIN_RPC_BACKPRESSURE_BYTES,
    rpcMaxPendingRequests: config.PLUGIN_RPC_MAX_PENDING_REQUESTS,
    rpcHeartbeatIntervalMs: config.PLUGIN_RPC_HEARTBEAT_INTERVAL_MS,
    rpcHeartbeatTimeoutMs: config.PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS,
    rpcReconnectBaseMs: config.PLUGIN_RPC_RECONNECT_BASE_MS,
    rpcReconnectMaxMs: config.PLUGIN_RPC_RECONNECT_MAX_MS,
    crashThreshold: config.PLUGIN_HOST_CRASH_THRESHOLD,
    crashWindowMs: config.PLUGIN_HOST_CRASH_WINDOW_MS,
    crashCooldownMs: config.PLUGIN_HOST_CRASH_COOLDOWN_MS,
    sweepIntervalMs: config.PLUGIN_SWEEP_INTERVAL_MS,
    retentionIntervalMs: config.PLUGIN_RETENTION_INTERVAL_MS,
    eventRetentionMs: config.PLUGIN_EVENT_RETENTION_DAYS * 86_400_000,
    entityHistoryRetentionMs:
      config.PLUGIN_ENTITY_HISTORY_RETENTION_DAYS * 86_400_000,
    retentionBatchSize: config.PLUGIN_RETENTION_BATCH_SIZE,
    dispatcherHttpPort: config.PLUGIN_DISPATCHER_HTTP_PORT,
    dispatcherHttpBind: config.PLUGIN_DISPATCHER_HTTP_BIND,
    dispatcherAuthToken: config.PLUGIN_DISPATCHER_AUTH_TOKEN,
    encodeTimeoutMs: config.PLUGIN_ENCODE_TIMEOUT_MS,
  };
}
