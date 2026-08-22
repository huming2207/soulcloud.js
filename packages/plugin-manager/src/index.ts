import { loadPluginManagerConfig, parsePluginEndpoints } from "./config";
import { PluginManager } from "./manager";
import { startPluginManagerServer } from "./server";

const config = loadPluginManagerConfig();
const manager = new PluginManager({
  endpoints: parsePluginEndpoints(config.PLUGIN_ENDPOINTS),
  authToken: process.env.PLUGIN_RPC_AUTH_TOKEN,
  maxFrameBytes: config.PLUGIN_RPC_MAX_FRAME_BYTES,
  maxPendingRequests: config.PLUGIN_RPC_MAX_PENDING_REQUESTS,
  backpressureBytes: config.PLUGIN_RPC_BACKPRESSURE_BYTES,
  heartbeatIntervalMs: config.PLUGIN_RPC_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: config.PLUGIN_RPC_HEARTBEAT_TIMEOUT_MS,
  reconnectMs: config.PLUGIN_MANAGER_RECONNECT_MS,
});
manager.start();
const server = startPluginManagerServer({ hostname: config.PLUGIN_MANAGER_INTERNAL_BIND, port: config.PLUGIN_MANAGER_INTERNAL_PORT, serviceToken: config.PLUGIN_MANAGER_SERVICE_TOKEN, manager });
console.log(`[soulcloud-plugin-manager] listening on ${server.url}`);
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`[soulcloud-plugin-manager] ${signal}`); server.stop(); await manager.stop(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
