/**
 * Atomically snapshots explicit device targets and creates one queued command
 * per device (mirrors Rust `command_queue::enqueue_batch`).
 *
 * The transaction locks and increments each target device's
 * `next_command_sequence`, embeds the per-device command UUID and sequence in
 * its own MessagePack packet, and inserts one `command_batches` row plus one
 * `device_commands` row per device.
 *
 * Fleet/project/customer selection is intentionally outside this function:
 * callers must resolve the exact device IDs before enqueueing.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type TransactionClient } from "../db";
import { CommandQueueError } from "./errors";
import { COMMAND_NOTIFY_CHANNEL } from "./notify";
import type { DeviceCommand } from "../protocol/command";
import { encodeDeviceCommandExecution } from "../protocol/command";
import { commandExecution } from "../protocol/topic";

/** Maximum number of target devices per batch (M11: the old INT32_MAX
 * bound was a no-op; this is the real, enforced limit). */
export const MAX_BATCH_TARGETS = 1000;

export interface EnqueuedBatch {
  /** Stable identifier for tracking the batch. */
  id: string;
  /** Number of per-device commands created. */
  deviceCount: number;
}

interface TargetRow {
  id: string;
  device_uid: string;
  next_command_sequence: bigint;
}

export interface EnqueueBatchOptions {
  /**
   * Delivery deadline in seconds from enqueue time. NULL/undefined means
   * the command never expires: it is retried until the device completes
   * it. A past deadline moves the command to the `delivery_failed`
   * terminal state, releasing the per-device queue.
   */
  deliveryTimeoutSeconds?: number;
}

/**
 * Atomically creates a command batch for an explicit list of device IDs.
 *
 * @throws {CommandQueueError} when the targets are empty, duplicated, too
 * numerous, missing, unsuitable for MQTT topics, or the database fails.
 */
export async function enqueueBatch(
  prisma: PrismaClient,
  targetDeviceIds: string[],
  command: DeviceCommand,
  options: EnqueueBatchOptions = {},
): Promise<EnqueuedBatch> {
  if (targetDeviceIds.length === 0) {
    throw new CommandQueueError(
      "empty_targets",
      "a command batch must target at least one device",
    );
  }
  if (new Set(targetDeviceIds).size !== targetDeviceIds.length) {
    throw new CommandQueueError(
      "duplicate_targets",
      "a command batch contains duplicate device IDs",
    );
  }
  if (targetDeviceIds.length > MAX_BATCH_TARGETS) {
    throw new CommandQueueError(
      "too_many_targets",
      "the command batch contains too many target devices",
    );
  }

  const batchId = randomUUID();
  const deviceCount = targetDeviceIds.length;
  const deliveryExpiresAt =
    options.deliveryTimeoutSeconds === undefined
      ? null
      : new Date(Date.now() + options.deliveryTimeoutSeconds * 1000);
  // deterministic lock order: overlapping concurrent batches update the same
  // device rows; unsorted input could deadlock (Kimi low-risk)
  const sortedTargets = [...targetDeviceIds].sort();

  try {
    return await prisma.$transaction(async (tx) =>
      enqueueBatchInTransaction(tx, sortedTargets, command, {
        batchId,
        deviceCount,
        deliveryExpiresAt,
      }),
    );
  } catch (error) {
    if (error instanceof CommandQueueError) throw error;
    throw new CommandQueueError(
      "database",
      `command enqueue failed: ${(error as Error).message}`,
    );
  }
}

export interface PreparedBatch {
  batchId: string;
  deviceCount: number;
  deliveryExpiresAt: Date | null;
}

/**
 * Transaction-core of {@link enqueueBatch}: creates the batch and its
 * per-device commands on an EXISTING transaction. Callers that need the
 * enqueue atomic with further writes (e.g. the audit record of a plugin
 * action invocation) pass their transaction client directly; input must be
 * pre-validated (non-empty, deduplicated, existing devices).
 */
export async function enqueueBatchInTransaction(
  tx: TransactionClient,
  sortedTargetDeviceIds: string[],
  command: DeviceCommand,
  prepared: PreparedBatch,
): Promise<EnqueuedBatch> {
  const targetDeviceIds = sortedTargetDeviceIds;
  const { batchId, deviceCount, deliveryExpiresAt } = prepared;
  const targets = await tx.$queryRaw<TargetRow[]>`
    UPDATE devices
    SET next_command_sequence = next_command_sequence + 1
    WHERE id IN (${Prisma.join(targetDeviceIds)})
    RETURNING id, device_uid, next_command_sequence
  `;

  if (targets.length !== targetDeviceIds.length) {
    const found = new Set(targets.map((t) => t.id));
    const missing = targetDeviceIds.filter((id) => !found.has(id));
    throw new CommandQueueError(
      "missing_targets",
      `command target devices do not exist: ${missing.join(", ")}`,
      { missing },
    );
  }

  for (const target of targets) {
    try {
      commandExecution(target.device_uid);
    } catch {
      throw new CommandQueueError(
        "invalid_device_uid",
        `device ${target.id} has an invalid MQTT device UID`,
        { deviceId: target.id },
      );
    }
  }

  await tx.commandBatch.create({
    data: { id: batchId, deviceCount },
  });

  const rows = targets.map((target) => {
    const sequence = target.next_command_sequence - 1n;
    if (sequence < 1n) {
      throw new CommandQueueError(
        "invalid_sequence",
        `device ${target.id} command sequence is outside the supported range`,
        { deviceId: target.id },
      );
    }
    const id = randomUUID();
    return {
      id,
      batchId,
      deviceId: target.id,
      sequence,
      deliveryExpiresAt,
      payload: Buffer.from(
        encodeDeviceCommandExecution({
          // 16 raw binary bytes from the dashed UUID
          id: Buffer.from(id.replace(/-/g, ""), "hex"),
          seq: sequence,
          cmd: command.cmd,
          args: command.args,
        }),
      ),
      state: "queued",
    };
  });

  await tx.deviceCommand.createMany({ data: rows });

  // Wake up broker processes (lossy hint only; pg_notify inside a
  // transaction is delivered only after commit). If no broker is
  // listening, the poller picks the row up on its next interval.
  await tx.$executeRaw`SELECT pg_notify(${COMMAND_NOTIFY_CHANNEL}, ${batchId})`;

  return { id: batchId, deviceCount };
}
