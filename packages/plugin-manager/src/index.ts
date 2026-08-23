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
  maxReverseCallsPerOperation: config.PLUGIN_RPC_MAX_REVERSE_CALLS,
  backpressureBytes: config.PLUGIN_RPC_BACKPRESSURE_BYTES,
  heartbeatIntervalMs: config.PLUGIN_RPC_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: config.PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS,
  reconnectMs: config.PLUGIN_MANAGER_RECONNECT_MS,
  manifestStore: new PrismaManifestStore(prisma),
  eventStore: new PrismaPluginEventStore(prisma),
  eventPollIntervalMs: config.PLUGIN_EVENT_POLL_INTERVAL_MS,
  eventLeaseMs: config.PLUGIN_EVENT_LEASE_MS,
  eventBatchSize: config.PLUGIN_EVENT_BATCH_SIZE,
  eventTimeoutMs: config.PLUGIN_EVENT_TIMEOUT_MS,
  eventMaxAttempts: config.PLUGIN_EVENT_MAX_ATTEMPTS,
  eventRetentionDays: config.PLUGIN_EVENT_RETENTION_DAYS,
  historyRetentionDays: config.PLUGIN_ENTITY_HISTORY_RETENTION_DAYS,
  maintenanceIntervalMs: config.PLUGIN_MAINTENANCE_INTERVAL_MS,
});
await manager.start();
const server = startPluginManagerServer({ hostname: config.PLUGIN_MANAGER_INTERNAL_BIND, port: config.PLUGIN_MANAGER_INTERNAL_PORT, serviceToken: config.PLUGIN_MANAGER_SERVICE_TOKEN, manager, uiSessionSecret: config.PLUGIN_MANAGER_UI_SESSION_SECRET, uiSessionTtlSeconds: config.PLUGIN_UI_SESSION_TTL_SECONDS });
console.log(`[soulcloud-plugin-manager] listening on ${server.url}`);
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`[soulcloud-plugin-manager] ${signal}`); await server.stop(); await manager.stop(); await prisma.$disconnect(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
