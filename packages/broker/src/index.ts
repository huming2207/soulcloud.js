/**
 * Soulcloud MQTT broker process entry point.
 *
 * Embeds the Aedes MQTT broker (device-facing, TCP :1883), authenticates
 * devices against the shared PostgreSQL database, routes device uplink
 * messages, and runs the durable command publication poller. It does not
 * expose a human-facing HTTP API (that is @soulcloud/api).
 */

import { prisma } from "@soulcloud/core";
import { startBroker } from "./mqtt/broker";
import { attachDispatch } from "./mqtt/dispatch";
import { startCommandPoller } from "./mqtt/publish";
import { startCommandNotifier } from "./mqtt/notify";
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

const { aedes, close: closeBroker } = await startBroker(prisma, config.MQTT_BROKER_PORT);
attachDispatch(aedes, prisma, logger);
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
// Wake the poller immediately when the API process enqueues commands
// (lossy hint; the poll interval remains the correctness fallback).
const notifier = await startCommandNotifier(config.DATABASE_URL, () => poller.wake(), logger);
console.log(
  `[soulcloud-broker] MQTT broker listening on tcp://0.0.0.0:${config.MQTT_BROKER_PORT}`,
);

async function shutdown(signal: string) {
  console.log(`[soulcloud-broker] received ${signal}, shutting down`);
  poller.stop();
  await notifier.close();
  await closeBroker();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
