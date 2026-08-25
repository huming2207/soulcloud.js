import { prisma } from "@soulcloud/core";
import { loadPluginManagerConfig, parsePluginEndpoints } from "./config";
import { PluginManager, PrismaManifestStore, PrismaPluginEventStore } from "./manager";
import { startPluginManagerServer } from "./server";

const config = loadPluginManagerConfig();
const manager = new PluginManager({
  endpoints: parsePluginEndpoints(config.PLUGIN_ENDPOINTS),
  prisma,
  uiSessionSecret: config.PLUGIN_MANAGER_UI_SESSION_SECRET,
  uiSessionTtlSeconds: config.PLUGIN_UI_SESSION_TTL_SECONDS,
  authToken: config.PLUGIN_RPC_AUTH_TOKEN,
  maxFrameBytes: config.PLUGIN_RPC_MAX_FRAME_BYTES,
  maxPendingRequests: config.PLUGIN_RPC_MAX_PENDING_REQUESTS,
  maxOperations: config.PLUGIN_MANAGER_MAX_OPERATIONS,
  maxOperationsPerPlugin: config.PLUGIN_MANAGER_MAX_OPERATIONS_PER_PLUGIN,
  maxOperationsPerInstallation: config.PLUGIN_MANAGER_MAX_OPERATIONS_PER_INSTALLATION,
  maxReverseCallsPerOperation: config.PLUGIN_RPC_MAX_REVERSE_CALLS,
  maxPluginCallDepth: config.PLUGIN_RPC_MAX_PLUGIN_CALL_DEPTH,
  maxReverseConcurrency: config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY,
  maxReverseConcurrencyPerPlugin: config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_PLUGIN,
  maxReverseConcurrencyPerInstallation: config.PLUGIN_RPC_MAX_REVERSE_CONCURRENCY_PER_INSTALLATION,
  maxStagedCommands: config.PLUGIN_RPC_MAX_STAGED_COMMANDS,
  maxStagedCommandBytes: config.PLUGIN_RPC_MAX_STAGED_COMMAND_BYTES,
  valueBudget: {
    maxDepth: config.PLUGIN_RPC_MAX_VALUE_DEPTH,
    maxNodes: config.PLUGIN_RPC_MAX_VALUE_NODES,
    maxArrayItems: config.PLUGIN_RPC_MAX_ARRAY_ITEMS,
    maxStringBytes: config.PLUGIN_RPC_MAX_STRING_BYTES,
    maxBlobs: config.PLUGIN_RPC_MAX_BLOBS,
    maxBlobBytes: config.PLUGIN_RPC_MAX_BLOB_BYTES,
    maxTotalBlobBytes: config.PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES,
  },
  backpressureBytes: config.PLUGIN_RPC_BACKPRESSURE_BYTES,
  heartbeatIntervalMs: config.PLUGIN_RPC_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: config.PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS,
  connectTimeoutMs: config.PLUGIN_RPC_CONNECT_TIMEOUT_MS,
  reconnectMs: config.PLUGIN_MANAGER_RECONNECT_MS,
  manifestStore: new PrismaManifestStore(prisma),
  eventStore: new PrismaPluginEventStore(prisma),
  eventPollIntervalMs: config.PLUGIN_EVENT_POLL_INTERVAL_MS,
  eventLeaseMs: config.PLUGIN_EVENT_LEASE_MS,
  eventBatchSize: config.PLUGIN_EVENT_BATCH_SIZE,
  eventMaxConcurrency: config.PLUGIN_EVENT_MAX_CONCURRENCY,
  eventTimeoutMs: config.PLUGIN_EVENT_TIMEOUT_MS,
  eventMaxAttempts: config.PLUGIN_EVENT_MAX_ATTEMPTS,
  eventRetentionDays: config.PLUGIN_EVENT_RETENTION_DAYS,
  historyRetentionDays: config.PLUGIN_ENTITY_HISTORY_RETENTION_DAYS,
  maintenanceIntervalMs: config.PLUGIN_MAINTENANCE_INTERVAL_MS,
  retentionBatchSize: config.PLUGIN_RETENTION_BATCH_SIZE,
  retentionMaxBatches: config.PLUGIN_RETENTION_MAX_BATCHES,
  artifactUploadTimeoutMs: config.PLUGIN_ARTIFACT_UPLOAD_TIMEOUT_MS,
});
await manager.start();
const server = startPluginManagerServer({ hostname: config.PLUGIN_MANAGER_INTERNAL_BIND, port: config.PLUGIN_MANAGER_INTERNAL_PORT, serviceToken: config.PLUGIN_MANAGER_SERVICE_TOKEN, manager, uiSessionSecret: config.PLUGIN_MANAGER_UI_SESSION_SECRET, uiSessionTtlSeconds: config.PLUGIN_UI_SESSION_TTL_SECONDS, maxArtifactBytes: config.PLUGIN_ARTIFACT_MAX_BYTES });
console.log(`[soulcloud-plugin-manager] listening on ${server.url}`);
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`[soulcloud-plugin-manager] ${signal}`); await server.stop(); await manager.stop(); await prisma.$disconnect(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
