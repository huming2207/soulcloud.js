/**
 * Leases the oldest eligible command while preserving per-device queue order
 * (mirrors Rust `command_queue::lease_next`).
 *
 * Concurrent workers use `FOR UPDATE SKIP LOCKED`. A later command for a
 * device remains blocked while that device has an older row awaiting broker
 * acceptance or a terminal device result.
 */

import type { PrismaClient } from "../db";
import { CommandQueueError } from "./errors";

export interface LeasedCommand {
  /** Stable database identifier for the per-device command. */
  id: string;
  /** Hardware-facing UID used in the MQTT topic. */
  deviceUid: string;
  /** Validated, encoded generic command payload. */
  payload: Uint8Array;
  /** Number of times this row has been leased, including this lease. */
  attemptCount: number;
}

interface ClaimCandidate {
  id: string;
  payload: Buffer;
  attempt_count: number;
  device_uid: string;
}

/**
 * Claims the oldest eligible command, or null when nothing is eligible.
 *
 * @throws {CommandQueueError} when the lease expiry cannot be represented or
 * the claim fails.
 */
export async function leaseNext(
  prisma: PrismaClient,
  leaseDurationMs: number,
): Promise<LeasedCommand | null> {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new CommandQueueError(
      "lease_time_overflow",
      "lease duration is outside the supported range",
      { leaseDurationMs },
    );
  }

  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<ClaimCandidate[]>`
      SELECT dc.id, dc.payload, dc.attempt_count, d.device_uid
      FROM device_commands dc
      INNER JOIN devices d ON d.id = dc.device_id
      WHERE dc.available_at <= now()
        AND (dc.state = 'queued'
             OR (dc.state = 'leased' AND dc.lease_expires_at <= now()))
        AND NOT EXISTS (
            SELECT 1 FROM device_commands earlier
            WHERE earlier.device_id = dc.device_id
              AND earlier.state IN ('queued', 'leased', 'broker_accepted')
              AND (earlier.created_at, earlier.id) < (dc.created_at, dc.id)
        )
      ORDER BY dc.created_at, dc.id
      FOR UPDATE OF dc SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    await tx.$executeRaw`
      UPDATE device_commands
      SET state = 'leased',
          lease_expires_at = now() + make_interval(secs => ${leaseDurationMs / 1000}::double precision),
          broker_accepted_at = NULL,
          attempt_count = attempt_count + 1
      WHERE id = ${candidate.id}
    `;

    return {
      id: candidate.id,
      deviceUid: candidate.device_uid,
      payload: candidate.payload,
      attemptCount: candidate.attempt_count + 1,
    };
  });
}
