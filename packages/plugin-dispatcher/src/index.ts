/**
 * Plugin Dispatcher process entry point (§6.3).
 *
 * Trusted core process: leases plugin events from PostgreSQL, routes them
 * to isolated containerised Plugin Hosts over HTTP JSON-RPC, validates every
 * response and commits entity updates. It loads NO plugin code — only
 * manifest metadata. Docker/Kubernetes supervises host processes.
 *
 * Deployment note (§6.5): hosts are separate services addressed by
 * PLUGIN_HOST_URLS; no shared socket volume or child-process privilege is
 * required.
 */

import { Client } from "pg";
import { prisma, PLUGIN_EVENTS_CHANNEL } from "@soulcloud/core";
import { dispatcherCoreOptionsFromConfig, loadDispatcherConfig } from "./config";
import { startDispatcher } from "./dispatcher";

const config = loadDispatcherConfig();

const logger = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`[plugin-dispatcher] ${msg}`, fields ?? ""),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[plugin-dispatcher] ${msg}`, fields ?? ""),
  error: (msg: string, fields?: Record<string, unknown>) =>
    console.error(`[plugin-dispatcher] ${msg}`, fields ?? ""),
};

const dispatcher = startDispatcher(
  prisma,
  dispatcherCoreOptionsFromConfig(config),
  logger,
);

// LISTEN/NOTIFY wake-up (lossy by design; the poll interval is the
// correctness fallback — same contract as the broker's command poller).
const listener = new Client({ connectionString: config.DATABASE_URL });
listener.on("notification", (message) => {
  if (message.channel === PLUGIN_EVENTS_CHANNEL) {
    dispatcher.wake();
  }
});
listener.on("error", (error) => {
  logger.warn("pg listener error (poll interval covers correctness)", {
    error: error.message,
  });
});
await listener.connect();
await listener.query(`LISTEN ${PLUGIN_EVENTS_CHANNEL}`);

console.log(
  `[plugin-dispatcher] listening for plugin events (poll every ${config.PLUGIN_EVENT_POLL_INTERVAL_MS}ms, wake on ${PLUGIN_EVENTS_CHANNEL})`,
);
setInterval(() => {
  const stats = dispatcher.stats();
  logger.info("stats", {
    processed: stats.processed,
    completed: stats.completed,
    failed: stats.failed,
    dead: stats.deadLettered,
    inFlight: stats.inFlight,
  });
}, 60_000).unref?.();

async function shutdown(signal: string) {
  console.log(`[plugin-dispatcher] received ${signal}, shutting down`);
  await dispatcher.stop();
  await listener.end().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
