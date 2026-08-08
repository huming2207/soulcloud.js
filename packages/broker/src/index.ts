/**
 * Soulcloud MQTT broker process entry point.
 *
 * Embeds the Aedes MQTT broker (device-facing, MQTT over WebSocket;
 * TLS termination is expected at the reverse proxy), authenticates
 * devices against the shared PostgreSQL database, routes device uplink
 * messages, and runs the durable command publication poller. It does not
 * expose a human-facing HTTP API (that is @soulcloud/api).
 */

import { prisma } from "@soulcloud/core";
import { kickDeviceSession, startBroker } from "./mqtt/broker";
import { attachDispatch } from "./mqtt/dispatch";
import { startCommandPoller } from "./mqtt/publish";
import { startOtaPoller } from "./mqtt/ota-publish";
import { startNotifier } from "./mqtt/notify";
import { loadBrokerConfig } from "./config";

const config = loadBrokerConfig();

const logger = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`[soulcloud-broker] ${msg}`, fields ?? ""),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[soulcloud-broker] ${msg}`, fields ?? ""),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace") {
      console.log(`[soulcloud-broker] ${msg}`, fields ?? "");
    }
  },
};

const { aedes, close: closeBroker } = await startBroker(prisma, {
  port: config.MQTT_BROKER_PORT,
  path: config.MQTT_BROKER_PATH,
});

// Diagnostics: log why live sessions go away (keepalive timeout, stream
// errors, kicks). Aedes closes connections silently by default, which
// makes reconnect storms hard to attribute.
aedes.on("keepaliveTimeout", (client) => {
  logger.warn("client keepalive timeout", { clientId: client.id });
});
aedes.on("clientError", (client, err) => {
  logger.warn("client error", { clientId: client.id, error: err.message });
});
aedes.on("connectionError", (client, err) => {
  logger.warn("connection error", { clientId: client?.id, error: err.message });
});
aedes.on("client", (client) => {
  // NOTE: aedes Client has no "close" event (the type definition is
  // right) - disconnects surface on the broker as "clientDisconnect"
});
aedes.on("clientDisconnect", (client) => {
  logger.info("client disconnected", { clientId: client.id });
});
attachDispatch(aedes, prisma, logger, {
  maxPacketBytes: config.UPLINK_MAX_PACKET_BYTES,
  ratePerSecond: config.UPLINK_RATE_PER_SECOND,
  rateBurst: config.UPLINK_RATE_BURST,
});
const poller = startCommandPoller(
  aedes,
  prisma,
  {
    pollIntervalMs: config.COMMAND_POLL_INTERVAL_MS,
    leaseDurationMs: config.COMMAND_LEASE_SECONDS * 1000,
    retain: config.MQTT_COMMAND_RETAIN,
  },
  logger,
);
// OTA delivery: metadata + per-device download JWT over MQTT; the device
// fetches the bin over HTTP itself.
const otaPoller = startOtaPoller(
  aedes,
  prisma,
  {
    secret: config.JWT_SECRET,
    pollIntervalMs: config.OTA_POLL_INTERVAL_MS,
    leaseDurationMs: config.OTA_LEASE_SECONDS * 1000,
    tokenTtlSeconds: config.OTA_TOKEN_TTL_SECONDS,
    stallTimeoutMinutes: config.OTA_STALL_TIMEOUT_MINUTES,
  },
  logger,
);
// Wake the poller immediately when the API process enqueues commands
// (lossy hint; the poll interval remains the correctness fallback) and
// kill live sessions when credentials are revoked.
const notifier = await startNotifier(
  config.DATABASE_URL,
  {
    onCommand: () => poller.wake(),
    onOta: () => otaPoller.wake(),
    onCredentialRevoked: (deviceUid) => {
      const kicked = kickDeviceSession(aedes, deviceUid);
      logger.info("revoked device session", { deviceUid, kicked });
    },
  },
  logger,
);
console.log(
  `[soulcloud-broker] MQTT broker listening on ws://0.0.0.0:${config.MQTT_BROKER_PORT}${config.MQTT_BROKER_PATH}`,
);

async function shutdown(signal: string) {
  console.log(`[soulcloud-broker] received ${signal}, shutting down`);
  poller.stop();
  otaPoller.stop();
  await notifier.close();
  await closeBroker();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
