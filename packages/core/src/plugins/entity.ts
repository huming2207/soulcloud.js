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

import type { DbExecutor } from "../db";
import { PluginSystemError } from "./errors";
import type {
  DeviceProfileDescriptor,
  EntityDescriptor,
  EntityUpdate,
} from "@soulcloud/plugin-sdk";
import { validateEntityValue } from "@soulcloud/plugin-sdk";

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

interface RevisionRow {
  id: string;
  revision: number;
  descriptor: unknown;
}

/**
 * Ensures a descriptor revision exists for every entity of the profile,
 * creating revision N+1 when the canonical form changed. Returns the
 * latest revision id per entity key. Idempotent.
 */
export async function ensureEntityDescriptors(
  prisma: DbExecutor,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const descriptor of profile.entities) {
    const existing = await prisma.$queryRaw<RevisionRow[]>`
      SELECT id, revision, descriptor
      FROM entity_descriptor_revisions
      WHERE plugin_id = ${pluginId}
        AND profile_id = ${profile.id}
        AND profile_version = ${profile.version}
        AND entity_key = ${descriptor.key}
      ORDER BY revision DESC
      LIMIT 1
    `;
    const latest = existing[0];
    const canonical = canonicalDescriptor(descriptor);
    const stored = latest
      ? canonicalDescriptor(latest.descriptor as EntityDescriptor)
      : null;
    if (latest && stored === canonical) {
      byKey.set(descriptor.key, latest.id);
      continue;
    }
    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      INSERT INTO entity_descriptor_revisions
        (id, plugin_id, profile_id, profile_version, entity_key, revision, descriptor, deprecated)
      VALUES (${id}, ${pluginId}, ${profile.id}, ${profile.version}, ${descriptor.key},
              ${(latest?.revision ?? 0) + 1}, ${JSON.stringify(descriptor)}::jsonb, false)
    `;
    byKey.set(descriptor.key, id);
  }
  return byKey;
}

/**
 * Registers (or refreshes) the entity registry rows of one device for a
 * profile: descriptor revisions are ensured, then registry rows point at
 * the latest revision. Idempotent; used when a device is bound to a
 * profile and by tests. Plugin upgrades that deprecate entities mark rows
 * deprecated rather than deleting (§4.1).
 */
export async function registerDeviceEntities(
  prisma: DbExecutor,
  deviceId: string,
  pluginId: string,
  profile: DeviceProfileDescriptor,
): Promise<void> {
  const revisionIds = await ensureEntityDescriptors(prisma, pluginId, profile);
  for (const [entityKey, revisionId] of revisionIds) {
    await prisma.$executeRaw`
      INSERT INTO entity_registry (id, device_id, plugin_id, entity_key, descriptor_revision_id, deprecated)
      VALUES (${crypto.randomUUID()}, ${deviceId}, ${pluginId}, ${entityKey}, ${revisionId}, false)
      ON CONFLICT (device_id, plugin_id, entity_key)
      DO UPDATE SET descriptor_revision_id = EXCLUDED.descriptor_revision_id
    `;
  }
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
  descriptor: unknown;
}

async function loadEntityRegistry(
  prisma: DbExecutor,
  deviceId: string,
  pluginId: string,
  entityKey: string,
): Promise<RegistryRow> {
  const rows = await prisma.$queryRaw<RegistryRow[]>`
    SELECT er.id, rev.descriptor
    FROM entity_registry er
    INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
    WHERE er.device_id = ${deviceId}
      AND er.plugin_id = ${pluginId}
      AND er.entity_key = ${entityKey}
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

/** Uniform "level:code" fingerprint; no alarm renders as ":". */
function alarmKey(level: string | null, code: string | null): string {
  return level === null && code === null ? ":" : `${level ?? ""}:${code ?? ""}`;
}

function currentAlarmKey(row: CurrentStateRow): string {
  return alarmKey(row.alarm_level, row.alarm_code);
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
  const { deviceId, pluginId, update } = params;
  const registry = await loadEntityRegistry(
    prisma,
    deviceId,
    pluginId,
    update.entityKey,
  );
  const descriptor = registry.descriptor as EntityDescriptor;

  const valueCheck =
    update.value === undefined
      ? ({ ok: true } as const)
      : validateEntityValue(descriptor, update.value);
  if (!valueCheck.ok) {
    throw new PluginSystemError(
      "invalid_entity_update",
      `entity "${update.entityKey}": ${valueCheck.error}`,
      { deviceId, pluginId, entityKey: update.entityKey },
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

  // current state (upsert)
  const existing = await prisma.$queryRaw<CurrentStateRow[]>`
    SELECT value, quality, source_timestamp, sequence, alarm_level, alarm_code
    FROM entity_current_state
    WHERE entity_registry_id = ${registry.id}
    FOR UPDATE
  `;
  const current = existing[0];
  // EntityUpdate is a patch: omitted fields retain the current state. An
  // explicit null value/alarm clears that field, while `alarm: undefined`
  // does not clear an existing alarm.
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
  await prisma.$executeRaw`
    INSERT INTO entity_current_state
      (entity_registry_id, value, quality, source_timestamp, ingested_at, sequence, alarm_level, alarm_code, updated_at)
    VALUES (${registry.id}, ${JSON.stringify(value ?? null)}::jsonb, ${quality},
            ${sourceTimestamp}, now(), ${sequence}, ${alarmLevel}, ${alarmCode}, now())
    ON CONFLICT (entity_registry_id)
    DO UPDATE SET value = EXCLUDED.value, quality = EXCLUDED.quality,
      source_timestamp = EXCLUDED.source_timestamp, ingested_at = now(),
      sequence = EXCLUDED.sequence, alarm_level = EXCLUDED.alarm_level,
      alarm_code = EXCLUDED.alarm_code, updated_at = now()
  `;

  // history policy
  if (descriptor.history === "none") {
    return { entityKey: update.entityKey, historyAppended: false, skippedReason: "no_history_policy" };
  }

  if (descriptor.history === "changes") {
    const before = current
      ? `${JSON.stringify(current.value ?? null)}|${current.quality}|${currentAlarmKey(current)}`
      : null;
    const after = `${JSON.stringify(value ?? null)}|${quality}|${alarmKey(alarmLevel, alarmCode)}`;
    if (before === after) {
      return { entityKey: update.entityKey, historyAppended: false, skippedReason: "unchanged" };
    }
  }

  if (descriptor.history === "sampled") {
    // sampled: record value/quality/alarm changes immediately, otherwise
    // at most one row per sampleIntervalSeconds (§4 retention policy).
    const intervalMs = (descriptor.sampleIntervalSeconds ?? 60) * 1000;
    const last = await prisma.$queryRaw<{ ingested_at: Date }[]>`
      SELECT ingested_at FROM entity_history
      WHERE entity_registry_id = ${registry.id}
      ORDER BY id DESC
      LIMIT 1
    `;
    const lastSample = last[0];
    if (lastSample) {
      // `current` holds the PREVIOUS state (fetched before the upsert).
      const changed =
        current !== undefined &&
        (JSON.stringify(current.value ?? null) !== JSON.stringify(value ?? null) ||
          current.quality !== quality ||
          currentAlarmKey(current) !== alarmKey(alarmLevel, alarmCode));
      const ageMs = Date.now() - new Date(lastSample.ingested_at).getTime();
      if (!changed && ageMs < intervalMs) {
        return { entityKey: update.entityKey, historyAppended: false, skippedReason: "sample_suppressed" };
      }
    }
  }

  await prisma.$executeRaw`
    INSERT INTO entity_history
      (entity_registry_id, descriptor_revision_id, device_id, value, quality, source_timestamp, ingested_at, sequence, alarm_level, alarm_code)
    SELECT ${registry.id}, er.descriptor_revision_id, er.device_id,
           ${JSON.stringify(value ?? null)}::jsonb, ${quality},
           ${sourceTimestamp}, now(), ${sequence},
           ${alarmLevel}, ${alarmCode}
    FROM entity_registry er WHERE er.id = ${registry.id}
  `;
  return { entityKey: update.entityKey, historyAppended: true };
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
