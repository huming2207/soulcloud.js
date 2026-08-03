/**
 * Soulcloud REST API server entry point.
 *
 * Serves the human-facing HTTP API (health checks, command batches). It does
 * not connect to devices and does not own an MQTT event loop: the embedded
 * Aedes broker runs in the separate @soulcloud/broker process.
 */

import { prisma } from "@soulcloud/core";
import { createApp } from "./api/app";
import { loadApiConfig } from "./config";

const config = loadApiConfig();

// API_BIND_ADDRESS is "host:port" (e.g. "0.0.0.0:8080")
const [hostname, port] = config.API_BIND_ADDRESS.split(":");
if (!hostname || !port) {
  console.error(
    `Invalid API_BIND_ADDRESS: ${config.API_BIND_ADDRESS} (expected host:port)`,
  );
  process.exit(1);
}

const app = createApp(prisma);
app.listen({ hostname, port: Number(port) });
console.log(
  `[soulcloud-api] listening on ${config.API_BIND_ADDRESS}`,
);

async function shutdown(signal: string) {
  console.log(`[soulcloud-api] received ${signal}, shutting down`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
