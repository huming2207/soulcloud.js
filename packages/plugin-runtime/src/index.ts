import { startPluginRuntime } from "./server";
import type { PluginDefinition } from "@soulcloud/plugin-sdk";

const entrypoint = process.env.PLUGIN_ENTRYPOINT;
if (!entrypoint) throw new Error("PLUGIN_ENTRYPOINT is required");
const loaded = await import(entrypoint) as { default?: PluginDefinition; plugin?: PluginDefinition };
const definition = loaded.default ?? loaded.plugin;
if (!definition) throw new Error("PLUGIN_ENTRYPOINT must export default or plugin");
function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}
const port = positiveInteger("PLUGIN_PORT", 8090, 65_535);
const authToken = process.env.PLUGIN_RPC_AUTH_TOKEN;
if (!authToken || authToken.length < 32) throw new Error("PLUGIN_RPC_AUTH_TOKEN must be at least 32 characters");
const runtime = await startPluginRuntime(definition, {
  hostname: process.env.PLUGIN_BIND ?? "0.0.0.0",
  port,
  authToken,
  maxFrameBytes: positiveInteger("PLUGIN_RPC_MAX_FRAME_BYTES", 1024 * 1024, 64 * 1024 * 1024),
  maxConcurrentOperations: positiveInteger("PLUGIN_RPC_MAX_OPERATIONS", 8, 1024),
  backpressureBytes: positiveInteger("PLUGIN_RPC_BACKPRESSURE_BYTES", 4 * 1024 * 1024, 256 * 1024 * 1024),
  idleTimeoutSeconds: positiveInteger("PLUGIN_RPC_IDLE_TIMEOUT_SECONDS", 60, 960),
});
console.log(`[soulcloud-plugin] ready id=${runtime.manifest.id} version=${runtime.manifest.version} url=${runtime.url}`);
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`[soulcloud-plugin] ${signal}`); await runtime.close(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
