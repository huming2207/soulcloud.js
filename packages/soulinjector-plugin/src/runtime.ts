import { startPluginRuntime } from "@soulcloud/plugin-runtime/server";
import { createSoulInjectorPlugin } from "./plugin";
import { SoulInjectorRepository } from "./repository";

const repository = SoulInjectorRepository.fromEnv();
await repository.migrate();
const authToken = process.env.PLUGIN_RPC_AUTH_TOKEN;
if (!authToken || authToken.length < 32) throw new Error("PLUGIN_RPC_AUTH_TOKEN must be at least 32 characters");
const rawPort = process.env.PLUGIN_PORT ?? "8090";
if (!/^\d+$/.test(rawPort)) throw new Error("PLUGIN_PORT must be a positive integer");
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PLUGIN_PORT must be between 1 and 65535");
const runtime = await startPluginRuntime(createSoulInjectorPlugin(repository), {
  hostname: process.env.PLUGIN_BIND ?? "0.0.0.0",
  port,
  authToken,
  maxFrameBytes: Number(process.env.PLUGIN_RPC_MAX_FRAME_BYTES ?? 1024 * 1024),
});
console.log(`[soulcloud-soulinjector-plugin] ready url=${runtime.url}`);
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[soulcloud-soulinjector-plugin] ${signal}`);
  await runtime.close();
  await repository.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
