/**
 * Publishes queued commands to devices through the embedded Aedes broker.
 *
 * The poller leases the oldest eligible command (per-device order is enforced
 * by the lease query), publishes it to the device's `cmd/exec` topic at
 * QoS 1, and marks the row `broker_accepted` once `aedes.publish()` confirms
 * the broker accepted it. A local publish failure releases the lease so the
 * command can be retried.
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
  type PrismaClient,
} from "@soulcloud/core";

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
}

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
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
): CommandPoller {
  let running = false;
  let stopped = false;

  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await pollOnce(aedes, prisma, options, log);
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

/** One poll cycle: lease a command and publish it. */
export async function pollOnce(
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
): Promise<void> {
  // expire commands whose delivery deadline has passed (releases the
  // per-device queue; no-op when no deadlines are set)
  await expireDelayedCommands(prisma);

  const leased = await leaseNext(prisma, options.leaseDurationMs);
  if (!leased) return;

  // M2: never publish to an offline device. A QoS1 message to a clean-session
  // client is dropped by the broker, which would strand the command in
  // broker_accepted forever and block the per-device queue. Instead the
  // command stays queued and is delivered when the device reconnects.
  // (aedes exposes `clients` as a plain object keyed by clientId; the type
  // definitions only expose connectedClients, hence the duck typing)
  const clients = (aedes as unknown as { clients?: Record<string, unknown> }).clients;
  const online = clients ? leased.deviceUid in clients : false;
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
