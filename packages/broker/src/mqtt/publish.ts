/**
 * Publishes queued commands to devices through the embedded Aedes broker.
 *
 * The poller leases eligible commands (per-device order is enforced by the
 * lease query), publishes each to the device's `cmd/exec` topic at QoS 1,
 * and marks the row `broker_accepted` once `aedes.publish()` confirms the
 * broker accepted it. A local publish failure releases the lease so the
 * command can be retried. Each poll cycle drains a bounded number of
 * commands (see DEFAULT_DRAIN_MAX_PER_CYCLE).
 *
 * Unlike the Rust version (external broker + PUBACK tracking), the embedded
 * broker's publish callback IS the broker acceptance — a key simplification.
 */

import type { Aedes } from "aedes";
import {
  commandExecution,
  expireDelayedCommands,
  leaseNext,
  markBrokerAccepted,
  releaseLease,
  type LeasedCommand,
  type PrismaClient,
} from "@soulcloud/core";
import type { ConnectionRegistry } from "./connection-registry";

/**
 * Commands published per poll cycle before the cycle yields to the next
 * poll/wake. The pre-drain poller delivered at most one command per poll
 * interval (~2/s with the default 500 ms interval), so a 1000-command
 * batch took ~500 s even with every device online.
 */
export const DEFAULT_DRAIN_MAX_PER_CYCLE = 100;

/**
 * Retry delay when the device is connected but its SUBSCRIBE for the
 * cmd/exec topic is still in flight (esp-mqtt subscribes asynchronously
 * after CONNACK; the subscription registers within milliseconds).
 */
const SUBSCRIBE_RETRY_MS = 1_000;

export interface PollerOptions {
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Lease duration in milliseconds. */
  leaseDurationMs: number;
  /** Retained flag for command publications. */
  retain: boolean;
  /**
   * Delay before an offline-targeted command becomes claimable again
   * (prevents a busy poll loop while a device stays offline).
   */
  offlineRetryMs?: number;
  /**
   * Maximum commands published per poll cycle (bounded drain). Defaults
   * to DEFAULT_DRAIN_MAX_PER_CYCLE.
   */
  drainMaxPerCycle?: number;
  /**
   * Minimum interval between delivery-deadline expiry sweeps (ms). The
   * expiry sweep is a maintenance UPDATE; running it on every 500ms poll
   * cycle would hammer the table at fleet scale while deadline precision
   * only needs seconds. Defaults to DEFAULT_EXPIRY_INTERVAL_MS.
   */
  expiryIntervalMs?: number;
}

/** Default cadence for the delivery-deadline expiry sweep. */
export const DEFAULT_EXPIRY_INTERVAL_MS = 15_000;

export interface PollerLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface CommandPoller {
  /** Stops the poller. */
  stop: () => void;
  /** Triggers an immediate poll cycle (lossy wake-up hint). */
  wake: () => void;
}

/**
 * Starts the command publication poller.
 *
 * Polls on a fixed interval, and also immediately when `wake()` is called
 * (used by the LISTEN/NOTIFY wake-up). A cycle already in progress is not
 * restarted: it re-polls on its own afterwards.
 */
export function startCommandPoller(
  registry: ConnectionRegistry,
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
): CommandPoller {
  let running = false;
  let stopped = false;
  let lastExpiryAt = 0;

  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const now = Date.now();
      const runExpiry = now - lastExpiryAt >= (options.expiryIntervalMs ?? DEFAULT_EXPIRY_INTERVAL_MS);
      if (runExpiry) lastExpiryAt = now;
      await pollOnce(registry, aedes, prisma, options, log, runExpiry);
    } catch (error) {
      // pollOnce handles expected errors; this guards against unexpected
      // failures so a bad cycle never becomes an unhandled rejection.
      log.warn("command poll cycle failed", {
        error: (error as Error).message,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(poll, options.pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    wake: () => {
      void poll();
    },
  };
}

/** One poll cycle: drain up to `drainMaxPerCycle` queued commands.
 *  `runExpiry` (default true) gates the delivery-deadline sweep so the
 *  caller can throttle it independently of the drain cadence. */
export async function pollOnce(
  registry: ConnectionRegistry,
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
  runExpiry = true,
): Promise<void> {
  // expire commands whose delivery deadline has passed (releases the
  // per-device queue; no-op when no deadlines are set)
  if (runExpiry) await expireDelayedCommands(prisma);

  // bounded drain (WEB-05): the pre-drain poller published at most one
  // command per poll interval (~2/s per process with the default 500 ms),
  // so a 1000-device batch took ~500 s. Lease and publish several commands
  // per cycle, stopping when the queue is empty or the budget is spent.
  // Per-command errors are handled inside handleLeasedCommand; only a
  // database failure escapes (and is caught by the poll() wrapper).
  const budget = options.drainMaxPerCycle ?? DEFAULT_DRAIN_MAX_PER_CYCLE;
  for (let i = 0; i < budget; i++) {
    const leased = await leaseNext(prisma, options.leaseDurationMs);
    if (!leased) return;
    await handleLeasedCommand(registry, aedes, prisma, options, log, leased);
  }
}

/** Publishes one leased command, or defers it back to the queue. */
async function handleLeasedCommand(
  registry: ConnectionRegistry,
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
  leased: LeasedCommand,
): Promise<void> {
  // M2: never publish to an offline device. A QoS1 message to a clean-session
  // client is dropped by the broker, which would strand the command in
  // broker_accepted forever and block the per-device queue. Instead the
  // command stays queued and is delivered when the device reconnects.
  const online = registry.isConnected(leased.deviceUid);
  if (!online) {
    log.debug("device offline; deferring command", {
      commandId: leased.id,
      deviceUid: leased.deviceUid,
    });
    await prisma.deviceCommand.update({
      where: { id: leased.id, state: "leased" },
      data: {
        state: "queued",
        leaseExpiresAt: null,
        availableAt: new Date(Date.now() + (options.offlineRetryMs ?? 5_000)),
      },
    });
    return;
  }

  let topic: string;
  try {
    topic = commandExecution(leased.deviceUid);
  } catch (error) {
    // Unsafe UID cannot form a topic; return the command to the queue.
    log.warn("command has an invalid device UID", {
      commandId: leased.id,
      deviceUid: leased.deviceUid,
      error: (error as Error).message,
    });
    await releaseLease(prisma, leased.id);
    return;
  }

  // WEB-01: check the subscription, not just the connection: a client can
  // be connected while its SUBSCRIBE is still in flight (esp-mqtt
  // subscribes asynchronously after CONNACK). Publishing to a topic with
  // no subscriber is silently dropped on a clean-session client, yet
  // aedes.publish still resolves and the row is marked broker_accepted —
  // the command is then lost forever and blocks the per-device queue.
  // Same pattern as the OTA poller (ota-publish.ts). The registry tracks
  // subscriptions from aedes' subscribe/unsubscribe events.
  const subscribed = registry.isSubscribed(leased.deviceUid, topic);
  if (!subscribed) {
    log.debug("device not subscribed yet; deferring command", {
      commandId: leased.id,
      deviceUid: leased.deviceUid,
    });
    await prisma.deviceCommand.update({
      where: { id: leased.id, state: "leased" },
      data: {
        state: "queued",
        leaseExpiresAt: null,
        availableAt: new Date(Date.now() + SUBSCRIBE_RETRY_MS),
      },
    });
    return;
  }

  log.debug("publishing queued device command", {
    commandId: leased.id,
    deviceUid: leased.deviceUid,
    attemptCount: leased.attemptCount,
  });

  try {
    await publishToDevice(aedes, topic, leased.payload, options.retain);
  } catch (error) {
    log.warn("failed to publish device command; releasing lease", {
      commandId: leased.id,
      deviceUid: leased.deviceUid,
      error: (error as Error).message,
    });
    await releaseLease(prisma, leased.id);
    return;
  }

  await markBrokerAccepted(prisma, leased.id);
  log.info("MQTT broker accepted device command", {
    commandId: leased.id,
    deviceUid: leased.deviceUid,
  });
}

/** Publishes one command packet via Aedes, resolving on broker acceptance. */
function publishToDevice(
  aedes: Aedes,
  topic: string,
  payload: Uint8Array,
  retain: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    aedes.publish(
      {
        cmd: "publish",
        dup: false,
        topic,
        payload: Buffer.from(payload),
        qos: 1,
        retain,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
