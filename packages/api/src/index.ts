/**
 * Soulcloud REST API server entry point.
 *
 * Serves the human-facing HTTP API (health checks, command batches). It does
 * not connect to devices and does not own an MQTT event loop: the embedded
 * Aedes broker runs in the separate @soulcloud/broker process.
 */

import { prisma } from "@soulcloud/core";
import { createApp } from "./api/app";
import { startRolloutPoller } from "./rollout-poller";
import { loadApiConfig, parseBindAddress } from "./config";

const config = loadApiConfig();

// API_BIND_ADDRESS is "host:port" (e.g. "0.0.0.0:8080" or "[::1]:8080")
const bind = parseBindAddress(config.API_BIND_ADDRESS);
if (!bind) {
  console.error(
    `Invalid API_BIND_ADDRESS: ${config.API_BIND_ADDRESS} (expected host:port)`,
  );
  process.exit(1);
}
const { hostname, port } = bind;

const app = createApp(
  prisma,
  {
    secret: config.JWT_SECRET,
    accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: config.JWT_REFRESH_TTL_SECONDS,
  },
  config.OTA_TARGET_TTL_SECONDS,
  {},
  config.MAX_JSON_BODY_BYTES,
);
// WEB-09: Bun buffers request bodies up to maxRequestBodySize before
// handlers run; the firmware multipart path is streamed and capped at
// 2x MAX_FIRMWARE_BYTES, so an explicit ceiling slightly above that
// bounds buffering for everything else (the route-level JSON cap below
// is much tighter).
app.listen({
  hostname,
  port,
  maxRequestBodySize: config.MAX_BODY_BYTES,
});
// rollout FSM (proposal 19): slow, DB-only advance loop
const rolloutPoller = startRolloutPoller(
  prisma,
  {
    pollIntervalMs: config.ROLLOUT_POLL_INTERVAL_MS,
    targetTtlSeconds: config.OTA_TARGET_TTL_SECONDS,
  },
  {
    info: (msg, fields) => console.log(`[soulcloud-api] ${msg}`, fields ?? ""),
    warn: (msg, fields) => console.warn(`[soulcloud-api] ${msg}`, fields ?? ""),
  },
);
console.log(
  `[soulcloud-api] listening on ${config.API_BIND_ADDRESS}`,
);

async function shutdown(signal: string) {
  console.log(`[soulcloud-api] received ${signal}, shutting down`);
  rolloutPoller.stop();
  app.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
