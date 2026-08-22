import { Prisma, type PrismaClient } from "../db";
import { PLUGIN_EVENTS_CHANNEL } from "../queue/notify";
import type { DeviceEventEnvelope } from "../protocol/event";

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

export async function releasePluginEvent(
  prisma: PrismaClient,
  eventId: string,
  leaseToken: string,
  permanent: boolean,
  error: string,
  retryMs: number,
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
            last_error = ${error}
        WHERE id = ${eventId}::uuid AND state = 'leased' AND lease_token = ${leaseToken}
      `;
  return result === 1;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
