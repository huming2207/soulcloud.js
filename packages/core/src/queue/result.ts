/**
 * Idempotently records a validated terminal result from the target device
 * (mirrors Rust `command_queue::record_device_result`).
 *
 * A result also proves that the broker accepted the command, so this
 * transition may complete a `queued` or `leased` row if the result races the
 * worker's PUBACK handling. Later commands for the same device become
 * eligible only after this transition.
 */

import type { PrismaClient } from "../../generated/prisma/client";
import { CommandQueueError } from "./errors";
import type { DeviceCommandResult } from "../protocol/command";
import { decodeDeviceCommandResult } from "../protocol/command";

export type ResultRecordOutcome = "recorded" | "already_recorded";

const PENDING_STATES = ["queued", "leased", "broker_accepted"] as const;

interface StoredRow {
  sequence: bigint;
  state: string;
  result_packet: Buffer | null;
  device_uid: string;
}

/**
 * Records a terminal result, returning whether this call completed the row.
 *
 * @throws {CommandQueueError} with kind `result_mismatch` when the ID,
 * sequence or device UID does not identify the same command; with kind
 * `conflicting_result` when a semantically different second result arrives;
 * with kind `missing_stored_result` when a completed row has no packet.
 */
export async function recordDeviceResult(
  prisma: PrismaClient,
  deviceUid: string,
  result: DeviceCommandResult,
  packet: Uint8Array,
): Promise<ResultRecordOutcome> {
  // The wire ID is 16 raw binary bytes; the database primary key is the
  // dashed UUID string form.
  const commandId = uuidFromBytes(result.id);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<StoredRow[]>`
      SELECT dc.sequence, dc.state, dc.result_packet, d.device_uid
      FROM device_commands dc
      INNER JOIN devices d ON d.id = dc.device_id
      WHERE dc.id = ${commandId}
      FOR UPDATE OF dc
    `;
    const stored = rows[0];

    if (!stored) {
      throw new CommandQueueError(
        "result_mismatch",
        `result does not match device command ${commandId}`,
        { commandId },
      );
    }
    if (BigInt(stored.sequence) !== result.seq || stored.device_uid !== deviceUid) {
      throw new CommandQueueError(
        "result_mismatch",
        `result does not match device command ${commandId}`,
        { commandId },
      );
    }

    if (stored.state === "device_completed") {
      if (stored.result_packet === null) {
        throw new CommandQueueError(
          "missing_stored_result",
          `stored result for device command ${commandId} is missing`,
          { commandId },
        );
      }
      const storedResult = decodeStoredResult(commandId, stored.result_packet);
      if (sameSemanticResult(storedResult, result)) {
        return "already_recorded" as const;
      }
      throw new CommandQueueError(
        "conflicting_result",
        `device command ${commandId} already has a different result`,
        { commandId },
      );
    }

    if (!(PENDING_STATES as readonly string[]).includes(stored.state)) {
      throw new CommandQueueError(
        "result_mismatch",
        `result does not match device command ${commandId}`,
        { commandId },
      );
    }

    const now = new Date();
    await tx.deviceCommand.update({
      where: { id: commandId },
      data: {
        state: "device_completed",
        leaseExpiresAt: null,
        brokerAcceptedAt: now,
        resultCode: result.code,
        resultPacket: Buffer.from(packet),
        deviceCompletedAt: now,
      },
    });
    return "recorded" as const;
  });
}

function decodeStoredResult(
  commandId: string,
  packet: Uint8Array,
): DeviceCommandResult {
  try {
    return decodeDeviceCommandResult(packet);
  } catch (error) {
    throw new CommandQueueError(
      "invalid_stored_result",
      `stored result for device command ${commandId} is invalid`,
      { commandId, cause: error },
    );
  }
}

/** Compares two decoded results semantically (bytes for id, value equality otherwise). */
function sameSemanticResult(
  a: DeviceCommandResult,
  b: DeviceCommandResult,
): boolean {
  if (!bytesEqual(a.id, b.id) || a.seq !== b.seq || a.code !== b.code) {
    return false;
  }
  return argsEqual(a.payload, b.payload);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function argsEqual(
  a: Array<Record<string, unknown>> | null | undefined,
  b: Array<Record<string, unknown>> | null | undefined,
): boolean {
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    const ka = a![i]!;
    const kb = b![i]!;
    const keysA = Object.keys(ka);
    const keysB = Object.keys(kb);
    if (keysA.length !== 1 || keysB.length !== 1 || keysA[0] !== keysB[0]) {
      return false;
    }
    if (!valueEqual(ka[keysA[0]!], kb[keysB[0]!])) return false;
  }
  return true;
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  return a === b;
}

/** Converts 16 raw binary bytes to the dashed UUID string form. */
function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
