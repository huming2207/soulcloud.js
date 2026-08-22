import { Prisma, type PrismaClient } from "../db";

type TransactionClient = Prisma.TransactionClient;

export interface EntityDescriptorInput {
  key: string;
  valueType: "number" | "boolean" | "string" | "enum" | "binary";
  category: "primary" | "diagnostic" | "configuration" | "measurement" | "counter";
  unit?: string;
  enumValues?: string[];
  staleAfterSeconds?: number;
  history?: "none" | "changes" | "sampled" | "all";
}

export interface EntityUpdateInput {
  entityKey: string;
  value?: unknown;
  quality?: "good" | "bad" | "uncertain" | "stale" | "unknown";
  sourceTimestamp?: string;
  sequence?: bigint | number;
  alarm?: { level: "info" | "warning" | "critical"; code: string } | null;
}

/**
 * Registers one manifest profile while retaining immutable descriptor
 * revisions. A profile switch deprecates every descriptor not present in the
 * new profile; switching back reactivates the latest matching revision.
 */
export async function registerInstallationProfileEntities(
  prisma: PrismaClient,
  installationId: string,
  profileId: string,
  profileVersion: number,
  descriptors: readonly EntityDescriptorInput[],
): Promise<void> {
  await prisma.$transaction(async (tx) => registerInstallationProfileEntitiesInTransaction(tx, installationId, profileId, profileVersion, descriptors));
}

export async function registerInstallationProfileEntitiesInTransaction(
  tx: TransactionClient,
  installationId: string,
  profileId: string,
  profileVersion: number,
  descriptors: readonly EntityDescriptorInput[],
): Promise<void> {
    await tx.$executeRaw`SELECT id FROM plugin_installations WHERE id = ${installationId}::uuid FOR UPDATE`;
    const existing = await tx.pluginEntityDescriptor.findMany({
      where: { installationId },
      orderBy: { revision: "asc" },
    });
    const latest = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      const key = descriptorKey(row.profileId, row.profileVersion, row.entityKey);
      const old = latest.get(key);
      if (!old || row.revision > old.revision) latest.set(key, row);
    }

    const activeIds: string[] = [];
    const deprecatedIds: string[] = [];
    const newRows: Array<{
      installationId: string;
      profileId: string;
      profileVersion: number;
      entityKey: string;
      revision: number;
      valueType: string;
      category: string;
      unit?: string;
      enumValues?: Prisma.InputJsonValue;
      staleAfterSeconds?: number;
      history: string;
    }> = [];
    const wanted = new Set(descriptors.map((descriptor) => descriptor.key));

    for (const descriptor of descriptors) {
      const key = descriptorKey(profileId, profileVersion, descriptor.key);
      const old = latest.get(key);
      if (old && sameDescriptor(old, descriptor)) {
        activeIds.push(old.id);
        continue;
      }
      const revision = (old?.revision ?? 0) + 1;
      if (old) deprecatedIds.push(old.id);
      newRows.push({
        installationId,
        profileId,
        profileVersion,
        entityKey: descriptor.key,
        revision,
        valueType: descriptor.valueType,
        category: descriptor.category,
        unit: descriptor.unit,
        enumValues: descriptor.enumValues ? descriptor.enumValues : undefined,
        staleAfterSeconds: descriptor.staleAfterSeconds,
        history: descriptor.history ?? "none",
      });
    }

    for (const row of existing) {
      // A single installation may serve devices with different manifest
      // profiles. Only the profile being reconciled may be deprecated here;
      // another profile remains active while any device still uses it.
      if (
        row.profileId === profileId &&
        row.profileVersion === profileVersion &&
        !wanted.has(row.entityKey)
      ) {
        deprecatedIds.push(row.id);
      }
    }
    if (deprecatedIds.length > 0) {
      await tx.pluginEntityDescriptor.updateMany({
        where: { id: { in: [...new Set(deprecatedIds)] } },
        data: { deprecated: true },
      });
    }
    if (activeIds.length > 0) {
      await tx.pluginEntityDescriptor.updateMany({
        where: { id: { in: activeIds } },
        data: { deprecated: false },
      });
    }
    if (newRows.length > 0) {
      await tx.pluginEntityDescriptor.createMany({
        data: newRows.map((row) => ({
          ...row,
          enumValues: row.enumValues ?? undefined,
        })),
      });
    }
}

/** Deprecates descriptors whose profile is no longer used by any binding. */
export async function deprecateUnboundInstallationProfilesInTransaction(
  tx: TransactionClient,
  installationId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE plugin_entity_descriptors AS d
    SET deprecated = true
    WHERE d.installation_id = ${installationId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM plugin_device_bindings AS b
        WHERE b.installation_id = d.installation_id
          AND b.profile_id = d.profile_id
          AND b.profile_version = d.profile_version
      )
  `;
}

export interface ApplyEntityUpdatesOptions {
  installationId: string;
  deviceId: string;
  profileId: string;
  profileVersion: number;
  updates: readonly EntityUpdateInput[];
}

/** Applies a bounded update batch to current state and history in one DB transaction. */
export async function applyEntityUpdates(
  tx: TransactionClient,
  options: ApplyEntityUpdatesOptions,
): Promise<void> {
  if (options.updates.length > 4096) throw new Error("too many entity updates");
  const descriptors = await tx.pluginEntityDescriptor.findMany({
    where: {
      installationId: options.installationId,
      profileId: options.profileId,
      profileVersion: options.profileVersion,
      deprecated: false,
    },
  });
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.entityKey, descriptor]));
  const keys = [...new Set(options.updates.map((update) => update.entityKey))];
  const current = await tx.pluginEntityState.findMany({
    where: {
      installationId: options.installationId,
      deviceId: options.deviceId,
      entityKey: { in: keys },
    },
  });
  const currentByKey = new Map(current.map((row) => [row.entityKey, row]));
  const stateRows: Array<Record<string, unknown>> = [];
  const historyRows: Array<Record<string, unknown>> = [];

  for (const update of options.updates) {
    const descriptor = byKey.get(update.entityKey);
    if (!descriptor) throw new Error(`unknown or deprecated entity ${update.entityKey}`);
    if (update.value !== undefined && !valueMatches(descriptor.valueType, descriptor.enumValues, update.value)) {
      throw new Error(`invalid value for entity ${update.entityKey}`);
    }
    const previous = currentByKey.get(update.entityKey);
    const sequence = normalizeSequence(update.sequence);
    if (previous?.sequence !== null && previous?.sequence !== undefined && sequence !== undefined && sequence < previous.sequence) continue;
    const value = update.value === undefined ? previous?.value ?? null : toJsonValue(update.value);
    const quality = update.quality ?? previous?.quality ?? "unknown";
    const sourceTimestamp = parseTimestamp(update.sourceTimestamp);
    const alarmLevel = update.alarm?.level ?? (update.alarm === null ? null : previous?.alarmLevel ?? null);
    const alarmCode = update.alarm?.code ?? (update.alarm === null ? null : previous?.alarmCode ?? null);
    const row = {
      installation_id: options.installationId,
      device_id: options.deviceId,
      entity_key: update.entityKey,
      descriptor_revision: descriptor.revision,
      value,
      quality,
      source_timestamp: sourceTimestamp?.toISOString() ?? null,
      sequence: sequence?.toString() ?? null,
      alarm_level: alarmLevel,
      alarm_code: alarmCode,
    };
    stateRows.push(row);
    const changed = !previous || JSON.stringify(previous.value) !== JSON.stringify(value) || previous.quality !== quality;
    if (descriptor.history === "all" || (descriptor.history === "changes" && changed) || descriptor.history === "sampled") {
      historyRows.push(row);
    }
    currentByKey.set(update.entityKey, {
      ...previous,
      value: value === null ? null : value,
      quality,
      sequence: sequence ?? previous?.sequence ?? null,
      alarmLevel,
      alarmCode,
    } as (typeof current)[number]);
  }

  if (stateRows.length > 0) await upsertStateRows(tx, stateRows);
  if (historyRows.length > 0) await insertHistoryRows(tx, historyRows);
}

function descriptorKey(profileId: string, profileVersion: number, entityKey: string): string {
  return `${profileId}\u0000${profileVersion}\u0000${entityKey}`;
}

function sameDescriptor(row: { valueType: string; category: string; unit: string | null; enumValues: unknown; staleAfterSeconds: number | null; history: string }, descriptor: EntityDescriptorInput): boolean {
  return row.valueType === descriptor.valueType &&
    row.category === descriptor.category &&
    row.unit === (descriptor.unit ?? null) &&
    JSON.stringify(row.enumValues) === JSON.stringify(descriptor.enumValues ?? null) &&
    row.staleAfterSeconds === (descriptor.staleAfterSeconds ?? null) &&
    row.history === (descriptor.history ?? "none");
}

function valueMatches(valueType: string, enumValues: unknown, value: unknown): boolean {
  if (valueType === "number") return typeof value === "number" && Number.isFinite(value);
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "string") return typeof value === "string";
  if (valueType === "binary") return value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob;
  return typeof value === "string" && Array.isArray(enumValues) && enumValues.includes(value);
}

function normalizeSequence(sequence: bigint | number | undefined): bigint | undefined {
  if (sequence === undefined) return undefined;
  if (typeof sequence === "number") {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid entity sequence");
    return BigInt(sequence);
  }
  if (sequence < 0n) throw new Error("invalid entity sequence");
  return sequence;
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid entity source timestamp");
  return parsed;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return { $binary: Buffer.from(bytes).toString("base64") };
  }
  if (value instanceof Blob) throw new Error("Blob entity values are not supported; use Uint8Array");
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item) as Prisma.InputJsonValue);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = toJsonValue(item) as Prisma.InputJsonValue;
    return result;
  }
  if (value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

async function upsertStateRows(tx: TransactionClient, rows: Array<Record<string, unknown>>): Promise<void> {
  await tx.$executeRaw`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(installation_id uuid, device_id uuid, entity_key text,
           descriptor_revision integer, value jsonb, quality text,
           source_timestamp timestamptz, sequence bigint,
           alarm_level text, alarm_code text)
    )
    INSERT INTO plugin_entity_states
      (installation_id, device_id, entity_key, descriptor_revision, value,
       quality, source_timestamp, sequence, alarm_level, alarm_code, ingested_at)
    SELECT installation_id, device_id, entity_key, descriptor_revision, value,
      quality, source_timestamp, sequence, alarm_level, alarm_code, CURRENT_TIMESTAMP
    FROM incoming
    ON CONFLICT (installation_id, device_id, entity_key) DO UPDATE SET
      descriptor_revision = EXCLUDED.descriptor_revision,
      value = EXCLUDED.value,
      quality = EXCLUDED.quality,
      source_timestamp = EXCLUDED.source_timestamp,
      sequence = EXCLUDED.sequence,
      alarm_level = EXCLUDED.alarm_level,
      alarm_code = EXCLUDED.alarm_code,
      ingested_at = CURRENT_TIMESTAMP
  `;
}

async function insertHistoryRows(tx: TransactionClient, rows: Array<Record<string, unknown>>): Promise<void> {
  await tx.$executeRaw`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(installation_id uuid, device_id uuid, entity_key text,
           descriptor_revision integer, value jsonb, quality text,
           source_timestamp timestamptz, sequence bigint,
           alarm_level text, alarm_code text)
    )
    INSERT INTO plugin_entity_history
      (installation_id, device_id, entity_key, descriptor_revision, value,
       quality, source_timestamp, sequence, alarm_level, alarm_code, ingested_at)
    SELECT installation_id, device_id, entity_key, descriptor_revision, value,
      quality, source_timestamp, sequence, alarm_level, alarm_code, CURRENT_TIMESTAMP
    FROM incoming
  `;
}
