import { Prisma, type PrismaClient } from "../db";
import { enqueueBatchInTransaction } from "../queue/enqueue";
import type { DeviceCommand } from "../protocol/command";
import { PLUGIN_EVENTS_CHANNEL } from "../queue/notify";
import type { DeviceEventEnvelope } from "../protocol/event";
import { applyEntityUpdates, type EntityUpdateInput } from "./entities";

export type DeviceEventIngestStatus =
  | "inserted"
  | "duplicate"
  | "unknown_device";

export interface DeviceEventIngestResult {
  status: DeviceEventIngestStatus;
  eventId: string;
}

export interface LeasedPluginEvent {
  id: string;
  event_id: string;
  device_id: string;
  device_uid: string;
  project_id: string;
  seq: bigint;
  kind: string;
  schema: number;
  payload: Buffer;
  received_at: Date;
  installation_id: string;
  plugin_id: string;
  plugin_version: string;
  manifest_hash: string;
  profile_id: string;
  profile_version: number;
  installation_config: unknown;
  attempt_count: number;
  lease_token: string;
}

/**
 * Persists one generic device event without interpreting its plugin-owned
 * data. Binding and manifest fields are copied into the row so an upgrade
 * cannot change the route of an event that is already queued.
 *
 * The insert and NOTIFY share one transaction. NOTIFY is only a wake-up hint;
 * a manager always recovers rows by polling the durable queue.
 */
export async function ingestDeviceEvent(
  prisma: PrismaClient,
  deviceUid: string,
  envelope: DeviceEventEnvelope,
  payload: Uint8Array,
): Promise<DeviceEventIngestResult> {
  const eventId = bytesToHex(envelope.id);
  return prisma.$transaction(async (tx) => {
    const device = await tx.device.findUnique({
      where: { deviceUid },
      select: { id: true, projectId: true },
    });
    if (!device) return { status: "unknown_device", eventId };

    const binding = await tx.pluginDeviceBinding.findUnique({
      where: { deviceId: device.id },
      select: {
        installationId: true,
        profileId: true,
        profileVersion: true,
        installation: {
          select: {
            projectId: true,
            pluginId: true,
            pluginVersion: true,
            manifestHash: true,
            state: true,
            config: true,
          },
        },
      },
    });

    const routeIsValid =
      binding !== null &&
      binding.installation.projectId === device.projectId &&
      binding.installation.state === "enabled";
    const inserted = await tx.pluginEvent.createMany({
      data: {
        eventId,
        deviceId: device.id,
        seq: envelope.seq,
        kind: envelope.kind,
        schema: envelope.schema,
        // Keep the original envelope so the manager can pass plugin-owned
        // data through without a broker-side decode/re-encode cycle.
        payload: Buffer.from(payload),
        installationId: binding?.installationId,
        pluginId: binding?.installation.pluginId,
        pluginVersion: binding?.installation.pluginVersion,
        manifestHash: binding?.installation.manifestHash,
        profileId: binding?.profileId,
        profileVersion: binding?.profileVersion,
        installationConfig: binding
          ? binding.installation.config === null
            ? Prisma.JsonNull
            : (binding.installation.config as Prisma.InputJsonValue)
          : undefined,
        state: routeIsValid ? "queued" : "dead",
        lastError: routeIsValid
          ? undefined
          : binding === null
            ? "device has no plugin installation binding"
            : binding.installation.projectId !== device.projectId
              ? "plugin binding belongs to another project"
              : "plugin installation is disabled",
      },
      skipDuplicates: true,
    });

    if (inserted.count === 0) return { status: "duplicate", eventId };
    await tx.$executeRaw`SELECT pg_notify(${PLUGIN_EVENTS_CHANNEL}, ${eventId})`;
    return { status: "inserted", eventId };
  });
}

/** Claims a bounded batch. PostgreSQL time is used for both expiry and lease. */
export async function leasePluginEvents(
  prisma: PrismaClient,
  limit: number,
  leaseMs: number,
): Promise<LeasedPluginEvent[]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("event lease limit must be positive");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError("event lease duration must be positive");
  return prisma.$queryRaw<LeasedPluginEvent[]>`
    WITH candidates AS (
      SELECT e.id, e.device_id
      FROM plugin_events e
      WHERE e.installation_id IS NOT NULL
        AND e.state IN ('queued', 'leased')
        AND e.available_at <= CURRENT_TIMESTAMP
        AND (e.state = 'queued' OR e.lease_expires_at <= CURRENT_TIMESTAMP)
      ORDER BY e.available_at ASC, e.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE plugin_events e
    SET state = 'leased',
        attempt_count = e.attempt_count + 1,
        lease_expires_at = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
        lease_token = md5(random()::text || clock_timestamp()::text || e.id::text)
    FROM candidates c
    JOIN devices d ON d.id = c.device_id
    WHERE e.id = c.id
    RETURNING e.id, e.event_id, e.device_id, d.device_uid, d.project_id,
      e.seq, e.kind, e.schema, e.payload, e.received_at,
      e.installation_id, e.plugin_id, e.plugin_version, e.manifest_hash,
      e.profile_id, e.profile_version, e.installation_config,
      e.attempt_count, e.lease_token
  `;
}

export async function completePluginEvent(
  prisma: PrismaClient,
  eventId: string,
  leaseToken: string,
): Promise<boolean> {
  const result = await prisma.$executeRaw`
    UPDATE plugin_events
    SET state = 'completed', lease_expires_at = NULL, lease_token = NULL,
        finished_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
  `;
  return result === 1;
}

/** Extends active leases in one round trip while a Manager drains its batch. */
export async function renewPluginEventLeases(
  prisma: PrismaClient,
  leases: readonly { id: string; leaseToken: string }[],
  leaseMs: number,
): Promise<number> {
  if (leases.length === 0) return 0;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new RangeError("event lease duration must be positive");
  const rows = leases.map((lease) => ({ id: lease.id, lease_token: lease.leaseToken }));
  return prisma.$executeRaw`
    WITH active AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(id uuid, lease_token text)
    )
    UPDATE plugin_events e
    SET lease_expires_at = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond')
    FROM active a
    WHERE e.id = a.id
      AND e.state = 'leased'
      AND e.lease_token = a.lease_token
  `;
}

/** Completes an event and applies its Entity updates under the same commit. */
export async function completePluginEventWithUpdates(
  prisma: PrismaClient,
  eventId: string,
  leaseToken: string,
  entityContext: {
    installationId: string;
    deviceId: string;
    profileId: string;
    profileVersion: number;
    updates: readonly EntityUpdateInput[];
    commands?: readonly { deviceId: string; command: DeviceCommand }[];
  },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM plugin_events
      WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
      FOR UPDATE
    `;
    if (locked.length === 0) return false;
    await applyEntityUpdates(tx, entityContext);
    for (const intent of entityContext.commands ?? []) {
      await enqueueBatchInTransaction(tx, [intent.deviceId], intent.command);
    }
    const updated = await tx.$executeRaw`
      UPDATE plugin_events
      SET state = 'completed', lease_expires_at = NULL, lease_token = NULL,
          finished_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
    `;
    return updated === 1;
  });
}

export async function releasePluginEvent(
  prisma: PrismaClient,
  eventId: string,
  leaseToken: string,
  permanent: boolean,
  error: string,
  retryMs: number,
  consumeAttempt = true,
): Promise<boolean> {
  if (!permanent && (!Number.isInteger(retryMs) || retryMs < 0)) {
    throw new RangeError("event retry duration must be a non-negative integer");
  }
  const result = permanent
    ? await prisma.$executeRaw`
        UPDATE plugin_events
        SET state = 'dead', lease_expires_at = NULL, lease_token = NULL,
            finished_at = CURRENT_TIMESTAMP, last_error = ${error}
        WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
      `
    : await prisma.$executeRaw`
        UPDATE plugin_events
        SET state = 'queued', lease_expires_at = NULL, lease_token = NULL,
            available_at = CURRENT_TIMESTAMP + (${retryMs} * INTERVAL '1 millisecond'),
            attempt_count = CASE WHEN ${consumeAttempt} THEN attempt_count ELSE GREATEST(attempt_count - 1, 0) END,
            last_error = ${error}
        WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
      `;
  return result === 1;
}

/** Bounded retention sweep; active/queued events and current Entity state remain untouched. */
export async function purgePluginData(
  prisma: PrismaClient,
  eventRetentionDays: number,
  historyRetentionDays: number,
  batchSize = 2_000,
): Promise<{ events: number; history: number }> {
  if (!Number.isInteger(eventRetentionDays) || eventRetentionDays <= 0) throw new RangeError("event retention days must be positive");
  if (!Number.isInteger(historyRetentionDays) || historyRetentionDays <= 0) throw new RangeError("history retention days must be positive");
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new RangeError("retention batch size must be positive");
  const events = await prisma.$executeRaw`
    WITH old_rows AS (
      SELECT id FROM plugin_events
      WHERE state IN ('completed', 'dead')
        AND finished_at < CURRENT_TIMESTAMP - (${eventRetentionDays} * INTERVAL '1 day')
      ORDER BY finished_at ASC
      LIMIT ${batchSize}
    )
    DELETE FROM plugin_events e USING old_rows o WHERE e.id = o.id
  `;
  const history = await prisma.$executeRaw`
    WITH old_rows AS (
      SELECT id FROM plugin_entity_history
      WHERE ingested_at < CURRENT_TIMESTAMP - (${historyRetentionDays} * INTERVAL '1 day')
      ORDER BY ingested_at ASC, id ASC
      LIMIT ${batchSize}
    )
    DELETE FROM plugin_entity_history h USING old_rows o WHERE h.id = o.id
  `;
  return { events, history };
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
