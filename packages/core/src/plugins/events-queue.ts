/**
 * Durable plugin event queue (§6.3).
 *
 * Same pattern as the device command queue (`queue/lease.ts`):
 *   - `FOR UPDATE SKIP LOCKED` leasing,
 *   - lease expiry recovery for crashed dispatchers,
 *   - idempotent enqueue via idempotency_key (repeated device uploads must
 *     not create duplicate work),
 *   - exponential backoff with jitter, bounded attempts, dead-letter,
 *   - LISTEN/NOTIFY as a lossy wake-up; the poll interval is the
 *     correctness fallback.
 *
 * Routing note (§5/§6.3): the plugin is derived from the device's
 * installation binding INSIDE the enqueue transaction. The event payload
 * never carries a plugin id.
 */

import type { DbExecutor, PrismaClient } from "../db";
import { PluginSystemError } from "./errors";
import { PLUGIN_EVENTS_CHANNEL } from "../queue/notify";

/** Payload JSON ceiling at enqueue (§15 input limits). */
export const MAX_EVENT_PAYLOAD_JSON_BYTES = 256 * 1024;

export type PluginEventState =
  | "pending"
  | "leased"
  | "failed"
  | "completed"
  | "dead";

export interface PluginEventRow {
  id: string;
  pluginInstallationId: string;
  projectId: string;
  deviceId: string;
  deviceUid: string;
  pluginId: string;
  profileId: string;
  profileVersion: number;
  eventKind: string;
  schemaVersion: number;
  payload: unknown;
  state: PluginEventState;
  attemptCount: number;
  installationConfig: unknown;
}

interface LeaseCandidate {
  id: string;
  plugin_installation_id: string;
  project_id: string;
  device_id: string;
  device_uid: string;
  plugin_id: string;
  plugin_version: string;
  profile_id: string;
  profile_version: number;
  event_kind: string;
  schema_version: number;
  payload: unknown;
  attempt_count: number;
  config_json: unknown;
  installation_config: unknown;
}

export interface EnqueuePluginEventParams {
  deviceId: string;
  eventKind: string;
  schemaVersion: number;
  payload: unknown;
  /** Deduplicates repeated uploads (e.g. device retries after reconnect). */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  id: string;
  /** True when an event with the same idempotency key already existed. */
  duplicate: boolean;
}

function checkPayloadSize(payload: unknown): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
  } catch {
    throw new PluginSystemError("invalid_event", "event payload must be JSON serializable");
  }
  if (bytes > MAX_EVENT_PAYLOAD_JSON_BYTES) {
    throw new PluginSystemError(
      "invalid_event",
      `event payload of ${bytes} bytes exceeds the ${MAX_EVENT_PAYLOAD_JSON_BYTES}-byte ceiling`,
    );
  }
}

/**
 * Enqueues one device event, deriving the target installation from the
 * device's binding. Generic (builtin-profile) devices have no installation
 * and cannot enqueue plugin events.
 *
 * @throws {PluginSystemError} device_not_bound / invalid_event /
 * installation_not_enabled / database.
 */
export async function enqueuePluginEvent(
  prisma: PrismaClient,
  params: EnqueuePluginEventParams,
): Promise<EnqueueResult> {
  if (params.eventKind.trim().length === 0 || params.eventKind.length > 255) {
    throw new PluginSystemError("invalid_event", "event kind is blank or too long");
  }
  if (
    params.idempotencyKey !== undefined &&
    (params.idempotencyKey.length === 0 || params.idempotencyKey.length > 255)
  ) {
    throw new PluginSystemError("invalid_event", "idempotency key is blank or too long");
  }
  if (!Number.isSafeInteger(params.schemaVersion) || params.schemaVersion < 1) {
    throw new PluginSystemError("invalid_event", "schema version must be a positive integer");
  }
  checkPayloadSize(params.payload);

  try {
    return await prisma.$transaction(async (tx) => {
      const devices = await tx.$queryRaw<DeviceRow[]>`
        SELECT id, device_uid, plugin_installation_id, project_id,
               plugin_id, profile_id, profile_version
        FROM devices
        WHERE id = ${params.deviceId}
        FOR UPDATE
        LIMIT 1
      `;
      const device = devices[0];
      if (!device) {
        throw new PluginSystemError(
          "device_not_bound",
          `device ${params.deviceId} does not exist`,
        );
      }
      if (device.plugin_installation_id === null) {
        throw new PluginSystemError(
          "device_not_bound",
          `device ${params.deviceId} is on the builtin generic profile and has no plugin installation`,
        );
      }
      const installations = await tx.$queryRaw<{
        id: string;
        state: string;
        plugin_id: string;
        configured_plugin_version: string;
        config_json: unknown;
      }[]>`
        SELECT id, state, plugin_id, configured_plugin_version, config_json
        FROM plugin_installations
        WHERE id = ${device.plugin_installation_id}
        LIMIT 1
      `;
      const installation = installations[0];
      if (!installation) {
        throw new PluginSystemError(
          "device_not_bound",
          `device ${params.deviceId} references a missing installation ${device.plugin_installation_id}`,
        );
      }
      if (installation.state !== "enabled") {
        throw new PluginSystemError(
          "installation_not_enabled",
          `installation ${installation.id} is ${installation.state}; events are not accepted`,
        );
      }
      if (
        device.plugin_id === null ||
        device.profile_id === null ||
        device.profile_version === null
      ) {
        throw new PluginSystemError(
          "binding_mismatch",
          `device ${params.deviceId} has an incomplete plugin binding`,
        );
      }

      if (params.idempotencyKey !== undefined) {
        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM plugin_events
          WHERE device_id = ${params.deviceId}
            AND idempotency_key = ${params.idempotencyKey}
          LIMIT 1
        `;
        if (existing[0]) {
          return { id: existing[0].id, duplicate: true };
        }
      }

      const id = crypto.randomUUID();
      await tx.$executeRaw`
        INSERT INTO plugin_events
          (id, plugin_installation_id, device_id, project_id, device_uid,
           plugin_id, plugin_version, profile_id, profile_version,
           installation_config, event_kind, schema_version, payload, state, idempotency_key)
        VALUES (${id}, ${device.plugin_installation_id}, ${params.deviceId},
                ${device.project_id}, ${device.device_uid},
                ${installation.plugin_id}, ${installation.configured_plugin_version},
                ${device.profile_id}, ${device.profile_version},
                ${JSON.stringify(installation.config_json ?? {})}::jsonb,
                ${params.eventKind}, ${params.schemaVersion},
                ${JSON.stringify(params.payload ?? null)}::jsonb, 'pending',
                ${params.idempotencyKey ?? null})
      `;
      await tx.$executeRaw`
        SELECT pg_notify(${PLUGIN_EVENTS_CHANNEL}, ${id})
      `;
      return { id, duplicate: false };
    });
  } catch (error) {
    if (error instanceof PluginSystemError) throw error;
    throw new PluginSystemError(
      "database",
      `plugin event enqueue failed: ${(error as Error).message}`,
    );
  }
}

interface DeviceRow {
  id: string;
  device_uid: string;
  plugin_installation_id: string | null;
  project_id: string;
  plugin_id: string | null;
  profile_id: string | null;
  profile_version: number | null;
}

/**
 * Atomically leases the oldest available event of ONE installation.
 * Fairness across installations is the dispatcher's job (round-robin);
 * the database only guarantees per-installation FIFO and crash safety.
 *
 * The lease increments attempt_count: an attempt that ends without
 * completion (including lease expiry) counts.
 *
 * @throws {PluginSystemError} lease_time_overflow / database.
 */
export async function leaseNextPluginEvent(
  prisma: DbExecutor,
  params: {
    pluginInstallationId: string;
    leaseDurationMs: number;
  },
): Promise<PluginEventRow | null> {
  if (
    !Number.isSafeInteger(params.leaseDurationMs) ||
    params.leaseDurationMs <= 0
  ) {
    throw new PluginSystemError(
      "lease_time_overflow",
      "lease duration is outside the supported range",
      { leaseDurationMs: params.leaseDurationMs },
    );
  }
  const leaseSeconds = params.leaseDurationMs / 1000;
  const candidates = await prisma.$queryRaw<LeaseCandidate[]>`
    UPDATE plugin_events pe
    SET state = 'leased',
        lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::double precision),
        attempt_count = pe.attempt_count + 1
    FROM devices d
    WHERE d.id = pe.device_id
      AND pe.plugin_installation_id = ${params.pluginInstallationId}
      AND pe.state IN ('pending', 'failed')
      AND pe.available_at <= now()
      AND pe.id = (
        SELECT inner_pe.id
        FROM plugin_events inner_pe
        WHERE inner_pe.plugin_installation_id = ${params.pluginInstallationId}
          AND inner_pe.state IN ('pending', 'failed')
          AND inner_pe.available_at <= now()
        ORDER BY inner_pe.created_at, inner_pe.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
    RETURNING pe.id, pe.plugin_installation_id, pe.project_id, pe.device_id, pe.device_uid,
              pe.plugin_id, pe.plugin_version, pe.profile_id, pe.profile_version,
              pe.event_kind, pe.schema_version, pe.payload,
              pe.attempt_count, pe.installation_config
  `;
  const row = candidates[0];
  if (!row) return null;
  return {
    id: row.id,
    pluginInstallationId: row.plugin_installation_id,
    projectId: row.project_id,
    deviceId: row.device_id,
    deviceUid: row.device_uid,
    pluginId: row.plugin_id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    eventKind: row.event_kind,
    schemaVersion: row.schema_version,
    payload: row.payload,
    state: "leased",
    attemptCount: row.attempt_count,
    installationConfig: row.installation_config,
  };
}

/**
 * Marks a leased event completed and applies its (already validated)
 * entity updates in the SAME transaction — the event is only complete
 * when its side effects are durable (§6.3 "校验插件输出并提交给核心服务").
 */
export async function completePluginEvent(
  prisma: PrismaClient,
  params: {
    eventId: string;
    applyUpdates: (tx: DbExecutor) => Promise<void>;
  },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE plugin_events
      SET state = 'completed', lease_expires_at = NULL, finished_at = now()
      WHERE id = ${params.eventId} AND state = 'leased'
      RETURNING id
    `;
    if (!rows[0]) return false;
    await params.applyUpdates(tx);
    return true;
  });
}

/**
 * Records a failed attempt. Transient failures schedule an exponential
 * backoff retry; permanent failures (invalid plugin output) and exhausted
 * attempts dead-letter the event with the last error preserved.
 */
export async function failPluginEvent(
  prisma: DbExecutor,
  params: {
    eventId: string;
    error: string;
    permanent: boolean;
    maxAttempts: number;
    backoffMs: number;
  },
): Promise<{ state: PluginEventState }> {
  const rows = await prisma.$queryRaw<{ state: PluginEventState }[]>`
    UPDATE plugin_events
    SET state = CASE
          WHEN ${params.permanent} OR attempt_count >= ${params.maxAttempts}
            THEN 'dead'
          ELSE 'failed'
        END,
        last_error = ${params.error},
        available_at = CASE
          WHEN ${params.permanent} OR attempt_count >= ${params.maxAttempts}
            THEN available_at
          ELSE now() + make_interval(secs => ${params.backoffMs / 1000}::double precision)
        END,
        lease_expires_at = NULL,
        finished_at = CASE
          WHEN ${params.permanent} OR attempt_count >= ${params.maxAttempts}
            THEN now()
          ELSE NULL
        END
    WHERE id = ${params.eventId} AND state = 'leased'
    RETURNING state
  `;
  return { state: rows[0]?.state ?? "pending" };
}

/**
 * Recovers events whose lease expired (dispatcher crash or a hung host the
 * dispatcher failed to mark). Lease expiry consumes the attempt — the
 * attempt occupied a worker slot. Events past the attempt ceiling go to
 * dead; the rest become immediately retryable.
 *
 * @returns number of recovered events.
 */
export async function recoverExpiredPluginEventLeases(
  prisma: DbExecutor,
  params: { maxAttempts: number },
): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE plugin_events
    SET state = CASE WHEN attempt_count >= ${params.maxAttempts} THEN 'dead' ELSE 'failed' END,
        last_error = COALESCE(last_error, 'lease expired'),
        available_at = now(),
        lease_expires_at = NULL,
        finished_at = CASE WHEN attempt_count >= ${params.maxAttempts} THEN now() ELSE NULL END
    WHERE state = 'leased' AND lease_expires_at <= now()
    RETURNING id
  `;
  return rows.length;
}

/**
 * Installations that currently have leasable work (dispatcher fairness
 * input, §6.4 per-installation scheduling).
 */
export async function listInstallationsWithWork(
  prisma: DbExecutor,
): Promise<
  Array<{
    id: string;
    pluginId: string;
    configuredPluginVersion: string;
    configJson: unknown;
  }>
> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      plugin_id: string;
      configured_plugin_version: string;
      config_json: unknown;
    }>
  >`
    SELECT pi.id, pi.plugin_id, pi.configured_plugin_version, pi.config_json
    FROM plugin_installations pi
    WHERE pi.state = 'enabled'
      AND EXISTS (
        SELECT 1 FROM plugin_events pe
        WHERE pe.plugin_installation_id = pi.id
          AND pe.state IN ('pending', 'failed')
          AND pe.available_at <= now()
      )
    ORDER BY pi.id
  `;
  return rows.map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    configuredPluginVersion: row.configured_plugin_version,
    configJson: row.config_json,
  }));
}

/**
 * Moves installations whose configured version no longer matches the
 * deployed registry to `error` (§3: no silent upgrade/downgrade). The
 * comparison happens per (plugin_id -> version) in the application — an
 * SQL ANY() across rows would compare unrelated plugins' versions.
 * Returns the installation ids that changed state.
 */
export async function sweepInstallationVersions(
  prisma: DbExecutor,
  deployed: ReadonlyMap<string, string>,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; plugin_id: string; configured_plugin_version: string }>
  >`
    SELECT id, plugin_id, configured_plugin_version
    FROM plugin_installations
    WHERE state IN ('enabled', 'draining')
  `;
  const mismatches = rows
    .map((row) => {
      const version = deployed.get(row.plugin_id);
      if (version === row.configured_plugin_version) return null;
      return {
        id: row.id,
        detail:
          version === undefined
            ? `plugin ${row.plugin_id} is not present in the deployed registry`
            : `configured version ${row.configured_plugin_version} does not match deployed ${version}`,
      };
    })
    .filter((row): row is { id: string; detail: string } => row !== null);
  for (const row of mismatches) {
    await prisma.$executeRaw`
      UPDATE plugin_installations
      SET state = 'error',
          error_detail = ${row.detail},
          updated_at = now()
      WHERE id = ${row.id} AND state IN ('enabled', 'draining')
    `;
  }
  return mismatches.map((row) => row.id);
}
