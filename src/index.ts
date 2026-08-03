import { Elysia } from "elysia";
import { loadConfig } from "./config";
import { prisma, ping } from "./db";
import { startBroker } from "./mqtt/broker";
import { attachDispatch } from "./mqtt/dispatch";
import { startCommandPoller } from "./mqtt/publish";

const config = loadConfig();

// API_BIND_ADDRESS is "host:port" (e.g. "0.0.0.0:8080")
const [hostname, port] = config.API_BIND_ADDRESS.split(":");
if (!hostname || !port) {
  console.error(
    `Invalid API_BIND_ADDRESS: ${config.API_BIND_ADDRESS} (expected host:port)`,
  );
  process.exit(1);
}

const logger = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`[soulcloudjs] ${msg}`, fields ?? ""),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[soulcloudjs] ${msg}`, fields ?? ""),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace") {
      console.log(`[soulcloudjs] ${msg}`, fields ?? "");
    }
  },
};

// --- Embedded MQTT broker ---------------------------------------------------

const { aedes, server: brokerServer, close: closeBroker } = await startBroker(
  prisma,
  config.MQTT_BROKER_PORT,
);
attachDispatch(aedes, prisma, logger);
const stopPoller = startCommandPoller(
  aedes,
  prisma,
  {
    pollIntervalMs: config.COMMAND_POLL_INTERVAL_MS,
    leaseDurationMs: config.COMMAND_LEASE_SECONDS * 1000,
    retain: config.MQTT_COMMAND_RETAIN,
  },
  logger,
);
console.log(
  `[soulcloudjs] MQTT broker listening on tcp://0.0.0.0:${config.MQTT_BROKER_PORT}`,
);

// --- REST API ----------------------------------------------------------------

const app = new Elysia()
  .get("/health/live", () => ({ status: "ok" }))
  .get("/health/ready", async ({ set }) => {
    const ok = await ping();
    if (!ok) {
      set.status = 503;
      return { status: "not_ready" };
    }
    return { status: "ready" };
  });

app.listen({ hostname, port: Number(port) });
console.log(
  `[soulcloudjs] API server listening on ${config.API_BIND_ADDRESS}`,
);

// --- Graceful shutdown --------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`[soulcloudjs] received ${signal}, shutting down`);
  stopPoller();
  await closeBroker();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
