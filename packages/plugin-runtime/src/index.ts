import { startPluginRuntime } from "./server";
import type { PluginDefinition } from "@soulcloud/plugin-sdk";

const entrypoint = process.env.PLUGIN_ENTRYPOINT;
if (!entrypoint) throw new Error("PLUGIN_ENTRYPOINT is required");
const loaded = await import(entrypoint) as { default?: PluginDefinition; plugin?: PluginDefinition };
const definition = loaded.default ?? loaded.plugin;
if (!definition) throw new Error("PLUGIN_ENTRYPOINT must export default or plugin");
const port = Number.parseInt(process.env.PLUGIN_PORT ?? "8090", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PLUGIN_PORT must be a valid port");
const authToken = process.env.PLUGIN_RPC_AUTH_TOKEN;
if (!authToken || authToken.length < 32) throw new Error("PLUGIN_RPC_AUTH_TOKEN must be at least 32 characters");
const runtime = await startPluginRuntime(definition, {
  hostname: process.env.PLUGIN_BIND ?? "0.0.0.0",
  port,
  authToken,
  maxFrameBytes: Number.parseInt(process.env.PLUGIN_RPC_MAX_FRAME_BYTES ?? String(1024 * 1024), 10),
  backpressureBytes: Number.parseInt(process.env.PLUGIN_RPC_BACKPRESSURE_BYTES ?? String(4 * 1024 * 1024), 10),
});
console.log(`[soulcloud-plugin] ready id=${runtime.manifest.id} version=${runtime.manifest.version} url=${runtime.url}`);
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`[soulcloud-plugin] ${signal}`); runtime.close(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
