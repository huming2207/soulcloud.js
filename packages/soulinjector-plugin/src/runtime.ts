import { startPluginRuntime } from "@soulcloud/plugin-runtime/server";
import { createSoulInjectorPlugin } from "./plugin";
import { SoulInjectorRepository } from "./repository";

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

const repository = SoulInjectorRepository.fromEnv();
await repository.migrate();
const authToken = process.env.PLUGIN_RPC_AUTH_TOKEN;
if (!authToken || authToken.length < 32) throw new Error("PLUGIN_RPC_AUTH_TOKEN must be at least 32 characters");
const port = positiveInteger("PLUGIN_PORT", 8090, 65_535);
const maxFrameBytes = positiveInteger("PLUGIN_RPC_MAX_FRAME_BYTES", 1024 * 1024, 64 * 1024 * 1024);
const maxBlobBytes = positiveInteger("PLUGIN_RPC_MAX_BLOB_BYTES", 65_536, 64 * 1024 * 1024);
const maxTotalBlobBytes = positiveInteger("PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES", 256 * 1024, 64 * 1024 * 1024);
if (maxBlobBytes > maxTotalBlobBytes) throw new Error("PLUGIN_RPC_MAX_BLOB_BYTES cannot exceed PLUGIN_RPC_MAX_TOTAL_BLOB_BYTES");
const uploadCleanupIntervalMs = positiveInteger("SOULINJECTOR_PLUGIN_UPLOAD_CLEANUP_INTERVAL_MS", 300_000, 86_400_000);
const uploadCleanupBatchSize = positiveInteger("SOULINJECTOR_PLUGIN_UPLOAD_CLEANUP_BATCH_SIZE", 256, 10_000);
const runtime = await startPluginRuntime(createSoulInjectorPlugin(repository), {
  hostname: process.env.PLUGIN_BIND ?? "0.0.0.0",
  port,
  authToken,
  maxFrameBytes,
  maxConcurrentOperations: positiveInteger("PLUGIN_RPC_MAX_OPERATIONS", 8, 1024),
  backpressureBytes: positiveInteger("PLUGIN_RPC_BACKPRESSURE_BYTES", 4 * 1024 * 1024, 256 * 1024 * 1024),
  idleTimeoutSeconds: positiveInteger("PLUGIN_RPC_IDLE_TIMEOUT_SECONDS", 60, 960),
  valueBudget: {
    maxDepth: positiveInteger("PLUGIN_RPC_MAX_VALUE_DEPTH", 32, 128),
    maxNodes: positiveInteger("PLUGIN_RPC_MAX_VALUE_NODES", 4096, 1_000_000),
    maxArrayItems: positiveInteger("PLUGIN_RPC_MAX_ARRAY_ITEMS", 4096, 1_000_000),
    maxStringBytes: positiveInteger("PLUGIN_RPC_MAX_STRING_BYTES", 65_536, 64 * 1024 * 1024),
    maxBlobs: positiveInteger("PLUGIN_RPC_MAX_BLOBS", 16, 4096),
    maxBlobBytes,
    maxTotalBlobBytes,
  },
});
console.log(`[soulcloud-soulinjector-plugin] ready url=${runtime.url}`);
let cleanupRunning: Promise<void> | null = null;
const cleanupTimer = setInterval(() => {
  if (cleanupRunning) return;
  const running = repository.purgeExpiredArtifactUploads(uploadCleanupBatchSize)
    .then((count) => { if (count > 0) console.log(`[soulcloud-soulinjector-plugin] purged expired artifact uploads count=${count}`); })
    .catch((error) => console.error("[soulcloud-soulinjector-plugin] artifact upload cleanup failed", error));
  cleanupRunning = running;
  void running.finally(() => { if (cleanupRunning === running) cleanupRunning = null; });
}, uploadCleanupIntervalMs);
cleanupTimer.unref?.();
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[soulcloud-soulinjector-plugin] ${signal}`);
  clearInterval(cleanupTimer);
  if (cleanupRunning) await cleanupRunning;
  await runtime.close();
  await repository.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
