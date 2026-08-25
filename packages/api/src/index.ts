/**
 * Soulcloud REST API server entry point.
 *
 * Serves the human-facing HTTP API (health checks, command batches). It does
 * not connect to devices and does not own an MQTT event loop: the embedded
 * Aedes broker runs in the separate @soulcloud/broker process.
 */

import { prisma } from "@soulcloud/core";
import { createApp } from "./api/app";
import { getLogStreamHub } from "./api/log-stream";
import { getCommandStreamHub } from "./api/command-stream";
import { getOtaStreamHub } from "./api/ota-stream";
import { getStatusStreamHub } from "./api/status-stream";
import { getNotificationsHub } from "./api/notifications-stream";
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
  {
    argon2Concurrency: config.AUTH_ARGON2_CONCURRENCY,
    loginFailureCapacity: config.AUTH_LOGIN_FAILURE_CAPACITY,
  },
  {
    internalUrl: config.PLUGIN_MANAGER_INTERNAL_URL,
    serviceToken: config.PLUGIN_MANAGER_SERVICE_TOKEN,
    requestTimeoutMs: config.PLUGIN_MANAGER_REQUEST_TIMEOUT_MS,
    uploadTimeoutMs: config.PLUGIN_MANAGER_UPLOAD_TIMEOUT_MS,
    uiSessionSecret: config.PLUGIN_MANAGER_UI_SESSION_SECRET,
    uiOrigin: config.PLUGIN_UI_ORIGIN,
    uiSessionTtlSeconds: config.PLUGIN_UI_SESSION_TTL_SECONDS,
  },
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
  await app.stop(true);
  // close the per-stream pg LISTEN connections and pending debounce
  // timers so the process can exit without relying on process.exit()
  await Promise.allSettled([
    getLogStreamHub(prisma, "", { warn: () => {} }).close(),
    getCommandStreamHub(prisma, "", { warn: () => {} }).close(),
    getOtaStreamHub(prisma, "", { warn: () => {} }).close(),
    getStatusStreamHub(prisma, "", { warn: () => {} }).close(),
    getNotificationsHub("", { warn: () => {} }).close(),
  ]);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
