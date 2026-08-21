/**
 * Industrial entity model (§4): registry, descriptor revisions, current
 * state and history.
 *
 * Semantics implemented here:
 *   - entity identity is (plugin_id, device_id, entity_key); descriptor
 *     semantics are pinned per revision and history rows record the
 *     revision they were written under (§4.1: old data is never
 *     re-interpreted with a newer descriptor),
 *   - current state and history are separate tables: hot reads never scan
 *     history,
 *   - history policy comes from the descriptor: none / changes / sampled
 *     (minimum spacing, value changes still recorded) / all,
 *   - every value is validated against its descriptor before anything is
 *     written (the dispatcher is the authority; callers must not rely on
 *     plugin-side pre-checks).
 */

import { Prisma, type DbExecutor, type PrismaClient } from "../db";
import { PluginSystemError } from "./errors";
import type {
  DeviceProfileDescriptor,
  EntityDescriptor,
  EntityUpdate,
} from "@soulcloud/plugin-sdk";
import { validateEntityValue } from "@soulcloud/plugin-sdk";

function hasTransactionClient(
  prisma: PrismaClient | DbExecutor,
): prisma is PrismaClient {
  // Prisma's interactive transaction proxy also exposes `$transaction`, but
  // unlike the root client it does not expose the connection lifecycle API.
  return typeof (prisma as PrismaClient).$connect === "function";
}

// ---------------------------------------------------------------------------
// Descriptor revisions
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON form used to detect descriptor changes: a changed
 * canonical form creates a new revision (§4.1).
 */
export function canonicalDescriptor(
  descriptor: EntityDescriptor,
): string {
  const keys = Object.keys(descriptor).sort() as (keyof EntityDescriptor)[];
  const parts: string[] = [];
  for (const key of keys) {
    const value = descriptor[key];
    if (value !== undefined) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(";");
}

/**
 * Ensures descriptor revisions exist for every entity of the profile,
 * creating revision N+1 where the canonical form changed. Returns the
 * latest revision id per entity key. Idempotent.
 *
 * Set-based (review perf fix): ONE query loads the latest revision per
 * key; only new/changed descriptors issue INSERTs. When called through the
 * public Prisma client, the whole read/compute/insert sequence runs in one
 * transaction so the advisory lock is held for the entire operation.
 *
 * The transaction is important: the advisory lock in the transaction-core
 * below must cover the read/compute/insert sequence, not just the lock
 * statement itself.
 */
export async function ensureEntityDescriptors(
  prisma: PrismaClient | DbExecutor,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<Map<string, string>> {
  if (hasTransactionClient(prisma)) {
    return prisma.$transaction((tx) =>
      ensureEntityDescriptorsInTransaction(tx, pluginId, profile),
    );
  }
  return ensureEntityDescriptorsInTransaction(prisma, pluginId, profile);
}

/** Transaction-core used by binding/reconcile paths that already own a tx. */
export async function ensureEntityDescriptorsInTransaction(
  prisma: DbExecutor,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  if (profile.entities.length === 0) return byKey;

  // There may be no existing revision row to lock yet. A transaction-level
  // advisory lock gives all installations of the same plugin profile a
  // stable serialization point before latest-revision reads and inserts.
  // This runs after the caller's installation/device locks, preserving the
  // global lock order: installation -> device -> descriptor registry.
  const descriptorIdentity = JSON.stringify([
    pluginId,
    profile.id,
    profile.version,
  ]);
  // Keep the void-returning lock function out of the result set: Prisma's
  // PostgreSQL adapter cannot deserialize a `void` column from $queryRaw.
  await prisma.$queryRaw`
    WITH lock_acquired AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${descriptorIdentity}, 0))
    )
    SELECT true AS locked FROM lock_acquired
  `;

  const keys = profile.entities.map((d) => d.key);
  const existing = await prisma.$queryRaw<
    { entity_key: string; id: string; revision: number; descriptor: unknown }[]
  >`
    SELECT DISTINCT ON (rev.entity_key)
           rev.entity_key, rev.id, rev.revision, rev.descriptor
    FROM entity_descriptor_revisions rev
    WHERE rev.plugin_id = ${pluginId}
      AND rev.profile_id = ${profile.id}
      AND rev.profile_version = ${profile.version}
      AND rev.entity_key IN (${Prisma.join(keys)})
    ORDER BY rev.entity_key, rev.revision DESC
  `;
  const latestByKey = new Map(existing.map((row) => [row.entity_key, row]));

  const toInsert: Array<{ descriptor: EntityDescriptor; revision: number }> = [];
  for (const descriptor of profile.entities) {
    const latest = latestByKey.get(descriptor.key);
    const canonical = canonicalDescriptor(descriptor);
    const stored = latest
      ? canonicalDescriptor(latest.descriptor as EntityDescriptor)
      : null;
    if (latest && stored === canonical) {
      byKey.set(descriptor.key, latest.id);
      continue;
    }
    toInsert.push({ descriptor, revision: (latest?.revision ?? 0) + 1 });
  }
  for (const { descriptor, revision } of toInsert) {
    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      INSERT INTO entity_descriptor_revisions
        (id, plugin_id, profile_id, profile_version, entity_key, revision, descriptor, deprecated)
      VALUES (${id}, ${pluginId}, ${profile.id}, ${profile.version}, ${descriptor.key},
              ${revision}, ${JSON.stringify(descriptor)}::jsonb, false)
    `;
    byKey.set(descriptor.key, id);
  }
  return byKey;
}

/**
 * Points every entity of one device at the given latest revisions
 * (set-based single-statement upsert).
 */
export async function upsertRegistryRows(
  prisma: DbExecutor,
  deviceId: string,
  pluginId: string,
  revisionIds: ReadonlyMap<string, string>,
): Promise<void> {
  const entries = [...revisionIds.entries()];
  if (entries.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO entity_registry (id, device_id, plugin_id, entity_key, descriptor_revision_id, deprecated)
    SELECT gen_random_uuid(), ${deviceId}, ${pluginId}, k, r, false
    FROM (
      SELECT * FROM (VALUES ${Prisma.join(
        entries.map(([key, revisionId]) =>
          Prisma.sql`(${key}::text, ${revisionId}::uuid)`,
        ),
      )}) AS t(key, revision_id)
    ) AS pairs(k, r)
    ON CONFLICT (device_id, plugin_id, entity_key)
    DO UPDATE SET descriptor_revision_id = EXCLUDED.descriptor_revision_id,
                  deprecated = false
  `;
}

/**
 * Registers (or refreshes) the entity registry rows of one device for a
 * profile: descriptor revisions are ensured, then registry rows point at
 * the latest revision. Idempotent; used when a device is bound to a
 * profile and by tests. Plugin upgrades that deprecate entities mark rows
 * deprecated rather than deleting (§4.1).
 */
export async function registerDeviceEntities(
  prisma: PrismaClient | DbExecutor,
  deviceId: string,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<void> {
  if (hasTransactionClient(prisma)) {
    await prisma.$transaction((tx) =>
      registerDeviceEntitiesInTransaction(tx, deviceId, pluginId, profile),
    );
    return;
  }
  await registerDeviceEntitiesInTransaction(prisma, deviceId, pluginId, profile);
}

/** Transaction-core used by bind/reconcile paths that already own a tx. */
export async function registerDeviceEntitiesInTransaction(
  prisma: DbExecutor,
  deviceId: string,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<void> {
  const revisionIds = await ensureEntityDescriptorsInTransaction(
    prisma,
    pluginId,
    profile,
  );
  await upsertRegistryRows(prisma, deviceId, pluginId, revisionIds);
}

// ---------------------------------------------------------------------------
// Applying updates
// ---------------------------------------------------------------------------

export interface AppliedEntityUpdate {
  entityKey: string;
  /** Whether a history row was appended (policy + change dependent). */
  historyAppended: boolean;
  skippedReason?: "no_history_policy" | "unchanged" | "sample_suppressed";
}

interface RegistryRow {
  id: string;
  entity_key: string;
  descriptor_revision_id: string;
  descriptor: unknown;
}

async function loadEntityRegistry(
  prisma: DbExecutor,
  deviceId: string,
  pluginId: string,
  entityKey: string,
): Promise<RegistryRow> {
  const rows = await prisma.$queryRaw<RegistryRow[]>`
    SELECT er.id, er.entity_key, er.descriptor_revision_id, rev.descriptor
    FROM entity_registry er
    INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
    WHERE er.device_id = ${deviceId}
      AND er.plugin_id = ${pluginId}
      AND er.entity_key = ${entityKey}
      AND er.deprecated = false
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new PluginSystemError(
      "unknown_entity",
      `entity "${entityKey}" is not registered for device ${deviceId} (plugin ${pluginId})`,
      { deviceId, pluginId, entityKey },
    );
  }
  return row;
}

interface CurrentStateRow {
  value: unknown;
  quality: string;
  source_timestamp: Date | null;
  sequence: bigint | null;
  alarm_level: string | null;
  alarm_code: string | null;
}

type CurrentStateWithId = CurrentStateRow & { entity_registry_id: string };

/** Uniform "level:code" fingerprint; no alarm renders as ":". */
function alarmKey(level: string | null, code: string | null): string {
  return level === null && code === null ? ":" : `${level ?? ""}:${code ?? ""}`;
}

function currentAlarmKey(row: CurrentStateRow): string {
  return alarmKey(row.alarm_level, row.alarm_code);
}

function validateEntityUpdate(
  descriptor: EntityDescriptor,
  update: EntityUpdate,
): void {
  const valueCheck =
    update.value === undefined
      ? ({ ok: true } as const)
      : validateEntityValue(descriptor, update.value);
  if (!valueCheck.ok) {
    throw new PluginSystemError(
      "invalid_entity_update",
      `entity "${update.entityKey}": ${valueCheck.error}`,
    );
  }
  if (
    update.quality !== undefined &&
    !["good", "bad", "uncertain", "stale", "unknown"].includes(update.quality)
  ) {
    throw new PluginSystemError(
      "invalid_entity_update",
      `entity "${update.entityKey}": quality is invalid`,
    );
  }
  if (update.alarm !== undefined && update.alarm !== null) {
    if (
      typeof update.alarm !== "object" ||
      !["info", "warning", "critical"].includes(update.alarm.level) ||
      typeof update.alarm.code !== "string" ||
      update.alarm.code.length === 0 ||
      update.alarm.code.length > 64
    ) {
      throw new PluginSystemError(
        "invalid_entity_update",
        `entity "${update.entityKey}": alarm is invalid`,
      );
    }
  }
}

function resolveEntityState(
  update: EntityUpdate,
  current: CurrentStateRow | undefined,
): CurrentStateRow {
  const value = update.value === undefined ? current?.value ?? null : update.value;
  const quality = update.quality ?? current?.quality ?? "good";
  const sourceTimestamp =
    update.sourceTimestamp === undefined
      ? current?.source_timestamp ?? null
      : update.sourceTimestamp
        ? new Date(update.sourceTimestamp)
        : null;
  if (sourceTimestamp && Number.isNaN(sourceTimestamp.getTime())) {
    throw new PluginSystemError(
      "invalid_entity_update",
      `entity "${update.entityKey}": sourceTimestamp is not a valid date`,
    );
  }
  let sequence: bigint | null;
  try {
    sequence =
      update.sequence === undefined
        ? current?.sequence ?? null
        : update.sequence === null
          ? null
          : BigInt(update.sequence);
  } catch {
    throw new PluginSystemError(
      "invalid_entity_update",
      `entity "${update.entityKey}": sequence is not an integer`,
    );
  }
  let alarmLevel = current?.alarm_level ?? null;
  let alarmCode = current?.alarm_code ?? null;
  if (update.alarm !== undefined) {
    alarmLevel = update.alarm?.level ?? null;
    alarmCode = update.alarm?.code ?? null;
  }
  return {
    value,
    quality,
    source_timestamp: sourceTimestamp,
    sequence,
    alarm_level: alarmLevel,
    alarm_code: alarmCode,
  };
}

function entityStateChanged(
  current: CurrentStateRow | undefined,
  next: CurrentStateRow,
): boolean {
  if (!current) return true;
  return (
    JSON.stringify(current.value ?? null) !== JSON.stringify(next.value ?? null) ||
    current.quality !== next.quality ||
    currentAlarmKey(current) !== currentAlarmKey(next)
  );
}

/**
 * Applies ONE validated entity update: upserts current state and appends
 * history per the descriptor's policy. Callers are expected to have run
 * `validateEventUpdates` first (the dispatcher does); this function still
 * re-validates defensively — it is the last line before the database.
 *
 * @throws {PluginSystemError} unknown_entity / invalid_entity_update.
 */
export async function applyEntityUpdate(
  prisma: DbExecutor,
  params: {
    deviceId: string;
    pluginId: string;
    update: EntityUpdate;
  },
): Promise<AppliedEntityUpdate> {
  const results = await applyEntityUpdates(prisma, {
    deviceId: params.deviceId,
    pluginId: params.pluginId,
    updates: [params.update],
  });
  return results[0]!;
}

/**
 * Applies all updates from one plugin event in a set-based operation. Registry
 * and current-state rows are locked in two queries, then all state/history
 * writes use one statement each. Duplicate keys remain ordered patches.
 */
export async function applyEntityUpdates(
  prisma: DbExecutor,
  params: {
    deviceId: string;
    pluginId: string;
    updates: EntityUpdate[];
  },
): Promise<AppliedEntityUpdate[]> {
  const { deviceId, pluginId, updates } = params;
  if (updates.length === 0) return [];
  const keys = [...new Set(updates.map((update) => update.entityKey))];
  const registries = await prisma.$queryRaw<RegistryRow[]>`
    SELECT er.id, er.entity_key, er.descriptor_revision_id, rev.descriptor
    FROM entity_registry er
    INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
    WHERE er.device_id = ${deviceId}
      AND er.plugin_id = ${pluginId}
      AND er.entity_key IN (${Prisma.join(keys)})
      AND er.deprecated = false
    FOR UPDATE OF er
  `;
  const registryByKey = new Map(registries.map((row) => [row.entity_key, row]));
  for (const update of updates) {
    if (!registryByKey.has(update.entityKey)) {
      throw new PluginSystemError(
        "unknown_entity",
        `entity "${update.entityKey}" is not registered for device ${deviceId} (plugin ${pluginId})`,
        { deviceId, pluginId, entityKey: update.entityKey },
      );
    }
  }

  const registryIds = registries.map((row) => row.id);
  const currentRows = await prisma.$queryRaw<CurrentStateWithId[]>`
    SELECT entity_registry_id, value, quality, source_timestamp, sequence,
           alarm_level, alarm_code
    FROM entity_current_state
    WHERE entity_registry_id IN (${Prisma.join(registryIds)})
    FOR UPDATE
  `;
  const currentByRegistry = new Map<string, CurrentStateRow>(
    currentRows.map(({ entity_registry_id, ...row }) => [entity_registry_id, row]),
  );

  const sampledIds = registries
    .filter((row) => (row.descriptor as EntityDescriptor).history === "sampled")
    .map((row) => row.id);
  const latestSamples = new Map<string, Date>();
  let databaseNow: Date | null = null;
  if (sampledIds.length > 0) {
    const sampleRows = await prisma.$queryRaw<
      Array<{ entity_registry_id: string; ingested_at: Date | null; db_now: Date }>
    >`
      WITH db_clock AS (SELECT clock_timestamp() AS db_now),
      ids(entity_registry_id) AS (
        VALUES ${Prisma.join(sampledIds.map((id) => Prisma.sql`(${id}::uuid)`))}
      )
      SELECT ids.entity_registry_id, latest.ingested_at, db_clock.db_now
      FROM ids
      CROSS JOIN db_clock
      LEFT JOIN LATERAL (
        SELECT eh.ingested_at
        FROM entity_history eh
        WHERE eh.entity_registry_id = ids.entity_registry_id
        ORDER BY eh.id DESC
        LIMIT 1
      ) latest ON true
    `;
    databaseNow = sampleRows[0]?.db_now ?? null;
    for (const row of sampleRows) {
      if (row.ingested_at) latestSamples.set(row.entity_registry_id, row.ingested_at);
    }
  }

  const results: AppliedEntityUpdate[] = [];
  const currentUpserts = new Map<string, CurrentStateRow>();
  const historyRows: Array<{
    registryId: string;
    descriptorRevisionId: string;
    value: unknown;
    quality: string;
    sourceTimestamp: Date | null;
    sequence: bigint | null;
    alarmLevel: string | null;
    alarmCode: string | null;
  }> = [];

  for (const update of updates) {
    const registry = registryByKey.get(update.entityKey)!;
    const descriptor = registry.descriptor as EntityDescriptor;
    validateEntityUpdate(descriptor, update);
    const current = currentByRegistry.get(registry.id);
    const next = resolveEntityState(update, current);
    currentByRegistry.set(registry.id, next);
    currentUpserts.set(registry.id, next);

    if (descriptor.history === "none") {
      results.push({ entityKey: update.entityKey, historyAppended: false, skippedReason: "no_history_policy" });
      continue;
    }
    if (descriptor.history === "changes" && !entityStateChanged(current, next)) {
      results.push({ entityKey: update.entityKey, historyAppended: false, skippedReason: "unchanged" });
      continue;
    }
    if (descriptor.history === "sampled") {
      const last = latestSamples.get(registry.id);
      const changed = entityStateChanged(current, next);
      const ageMs = last && databaseNow
        ? databaseNow.getTime() - last.getTime()
        : Number.POSITIVE_INFINITY;
      if (last && !changed && ageMs < (descriptor.sampleIntervalSeconds ?? 60) * 1000) {
        results.push({ entityKey: update.entityKey, historyAppended: false, skippedReason: "sample_suppressed" });
        continue;
      }
      latestSamples.set(registry.id, databaseNow ?? new Date(0));
    }
    historyRows.push({
      registryId: registry.id,
      descriptorRevisionId: registry.descriptor_revision_id,
      value: next.value,
      quality: next.quality,
      sourceTimestamp: next.source_timestamp,
      sequence: next.sequence,
      alarmLevel: next.alarm_level,
      alarmCode: next.alarm_code,
    });
    results.push({ entityKey: update.entityKey, historyAppended: true });
  }

  await prisma.$executeRaw`
    INSERT INTO entity_current_state
      (entity_registry_id, value, quality, source_timestamp, ingested_at,
       sequence, alarm_level, alarm_code, updated_at)
    VALUES ${Prisma.join(
      [...currentUpserts].map(([registryId, state]) => Prisma.sql`(
        ${registryId}::uuid, ${JSON.stringify(state.value ?? null)}::jsonb,
        ${state.quality}, ${state.source_timestamp}, now(), ${state.sequence},
        ${state.alarm_level}, ${state.alarm_code}, now()
      )`),
    )}
    ON CONFLICT (entity_registry_id)
    DO UPDATE SET value = EXCLUDED.value, quality = EXCLUDED.quality,
      source_timestamp = EXCLUDED.source_timestamp, ingested_at = now(),
      sequence = EXCLUDED.sequence, alarm_level = EXCLUDED.alarm_level,
      alarm_code = EXCLUDED.alarm_code, updated_at = now()
  `;

  if (historyRows.length > 0) {
    await prisma.$executeRaw`
      INSERT INTO entity_history
        (entity_registry_id, descriptor_revision_id, device_id, value, quality,
         source_timestamp, ingested_at, sequence, alarm_level, alarm_code)
      VALUES ${Prisma.join(
        historyRows.map((row) => Prisma.sql`(
          ${row.registryId}::uuid, ${row.descriptorRevisionId}::uuid,
          ${deviceId}::uuid, ${JSON.stringify(row.value ?? null)}::jsonb,
          ${row.quality}, ${row.sourceTimestamp}, now(), ${row.sequence},
          ${row.alarmLevel}, ${row.alarmCode}
        )`),
      )}
    `;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Queries (stage 1 index targets, §4.1)
// ---------------------------------------------------------------------------

export interface EntityStateView {
  entityKey: string;
  pluginId: string;
  value: unknown;
  quality: string;
  sourceTimestamp: string | null;
  /** Null when the entity has no current-state row yet. */
  ingestedAt: string | null;
  sequence: string | null;
  alarmLevel: string | null;
  alarmCode: string | null;
}

/** Current states of every entity of one device (index: entity_registry(device_id)). */
export async function getDeviceEntityStates(
  prisma: DbExecutor,
  deviceId: string,
): Promise<EntityStateView[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      entity_key: string;
      plugin_id: string;
      value: unknown;
      quality: string | null;
      source_timestamp: Date | null;
      ingested_at: Date | null;
      sequence: bigint | null;
      alarm_level: string | null;
      alarm_code: string | null;
    }>
  >`
    SELECT er.entity_key, er.plugin_id, cs.value,
           COALESCE(cs.quality, 'unknown') AS quality,
           cs.source_timestamp, cs.ingested_at, cs.sequence,
           cs.alarm_level, cs.alarm_code
    FROM entity_registry er
    LEFT JOIN entity_current_state cs ON cs.entity_registry_id = er.id
    WHERE er.device_id = ${deviceId}
      AND er.deprecated = false
    ORDER BY er.entity_key
  `;
  return rows.map((row) => ({
    entityKey: row.entity_key,
    pluginId: row.plugin_id,
    value: row.value,
    quality: row.quality ?? "unknown",
    sourceTimestamp: row.source_timestamp?.toISOString() ?? null,
    ingestedAt: row.ingested_at?.toISOString() ?? null,
    sequence: row.sequence === null ? null : row.sequence.toString(),
    alarmLevel: row.alarm_level,
    alarmCode: row.alarm_code,
  }));
}

export interface EntityHistoryView {
  id: string;
  entityKey: string;
  value: unknown;
  quality: string;
  sourceTimestamp: string | null;
  ingestedAt: string;
  alarmLevel: string | null;
  alarmCode: string | null;
  descriptorRevision: number;
}

/**
 * Keyset-paged entity history for one device, optionally one entity.
 * Indexes: entity_history(device_id, id) and (entity_registry_id, id).
 */
export async function getDeviceEntityHistory(
  prisma: DbExecutor,
  params: {
    deviceId: string;
    entityKey?: string;
    pluginId?: string;
    /** Keyset cursor: return rows with id strictly greater than this. */
    afterId?: bigint;
    limit?: number;
  },
): Promise<EntityHistoryView[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const afterId = params.afterId ?? 0n;
  const rows = await prisma.$queryRaw<
    Array<{
      id: bigint;
      entity_key: string;
      value: unknown;
      quality: string;
      source_timestamp: Date | null;
      ingested_at: Date;
      alarm_level: string | null;
      alarm_code: string | null;
      revision: number;
    }>
  >`
    SELECT eh.id, er.entity_key, eh.value, eh.quality, eh.source_timestamp,
           eh.ingested_at, eh.alarm_level, eh.alarm_code, rev.revision
    FROM entity_history eh
    INNER JOIN entity_registry er ON er.id = eh.entity_registry_id
    INNER JOIN entity_descriptor_revisions rev ON rev.id = eh.descriptor_revision_id
    WHERE eh.device_id = ${params.deviceId}
      AND eh.id > ${afterId}
      AND (${params.entityKey ?? null}::text IS NULL OR er.entity_key = ${params.entityKey ?? null})
      AND (${params.pluginId ?? null}::text IS NULL OR er.plugin_id = ${params.pluginId ?? null})
    ORDER BY eh.id
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id.toString(),
    entityKey: row.entity_key,
    value: row.value,
    quality: row.quality,
    sourceTimestamp: row.source_timestamp?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    alarmLevel: row.alarm_level,
    alarmCode: row.alarm_code,
    descriptorRevision: row.revision,
  }));
}
