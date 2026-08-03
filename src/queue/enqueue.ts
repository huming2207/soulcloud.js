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
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { CommandQueueError } from "./errors";
import type { DeviceCommand } from "../protocol/command";
import { encodeDeviceCommandExecution } from "../protocol/command";
import { commandExecution } from "../protocol/topic";

const INT32_MAX = 2_147_483_647;

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
  if (targetDeviceIds.length > INT32_MAX) {
    throw new CommandQueueError(
      "too_many_targets",
      "the command batch contains too many target devices",
    );
  }

  const batchId = randomUUID();
  const deviceCount = targetDeviceIds.length;

  return prisma.$transaction(async (tx) => {
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

    return { id: batchId, deviceCount };
  });
}
