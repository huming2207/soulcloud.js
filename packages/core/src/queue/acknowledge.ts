/**
 * Command state transitions driven by MQTT broker acknowledgement
 * (mirrors Rust `command_queue::mark_broker_accepted` / `release_lease`).
 */

import type { PrismaClient } from "../db";
import { CommandQueueError } from "./errors";

/**
 * Marks a leased command as accepted by the MQTT broker (QoS 1 PUBACK).
 *
 * Idempotent: a row already in `broker_accepted` or `device_completed` is
 * accepted silently (the result may have raced the PUBACK handling).
 *
 * @throws {CommandQueueError} with kind `lease_conflict` when the command is
 * no longer leased.
 */
export async function markBrokerAccepted(
  prisma: PrismaClient,
  commandId: string,
): Promise<void> {
  const updated = await prisma.deviceCommand.updateMany({
    where: { id: commandId, state: "leased" },
    data: {
      state: "broker_accepted",
      leaseExpiresAt: null,
      brokerAcceptedAt: new Date(),
    },
  });
  if (updated.count === 1) return;

  const row = await prisma.deviceCommand.findUnique({
    where: { id: commandId },
    select: { state: true },
  });
  if (
    row &&
    (row.state === "broker_accepted" || row.state === "device_completed")
  ) {
    return; // idempotent: already accepted or completed
  }
  throw new CommandQueueError(
    "lease_conflict",
    `device command ${commandId} is no longer leased`,
    { commandId },
  );
}

/**
 * Releases a command lease back to `queued` after publication could not be
 * queued locally.
 *
 * @throws {CommandQueueError} with kind `lease_conflict` when the command is
 * no longer leased.
 */
export async function releaseLease(
  prisma: PrismaClient,
  commandId: string,
): Promise<void> {
  const updated = await prisma.deviceCommand.updateMany({
    where: { id: commandId, state: "leased" },
    data: {
      state: "queued",
      availableAt: new Date(),
      leaseExpiresAt: null,
      brokerAcceptedAt: null,
    },
  });
  if (updated.count === 1) return;
  throw new CommandQueueError(
    "lease_conflict",
    `device command ${commandId} is no longer leased`,
    { commandId },
  );
}
