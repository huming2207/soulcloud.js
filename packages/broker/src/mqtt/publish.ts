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
}

export interface PollerLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Starts the command publication poller.
 *
 * @returns a function that stops the poller.
 */
export function startCommandPoller(
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
): () => void {
  let running = false;
  let stopped = false;

  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      await pollOnce(aedes, prisma, options, log);
    } finally {
      running = false;
    }
  }, options.pollIntervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** One poll cycle: lease a command and publish it. */
export async function pollOnce(
  aedes: Aedes,
  prisma: PrismaClient,
  options: PollerOptions,
  log: PollerLog,
): Promise<void> {
  const leased = await leaseNext(prisma, options.leaseDurationMs);
  if (!leased) return;

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
