import { Prisma, type PrismaClient } from "../db";
import {
  deprecateUnboundInstallationProfilesInTransaction,
  registerInstallationProfileEntitiesInTransaction,
  type EntityDescriptorInput,
} from "./entities";

interface ManifestProfile {
  id: string;
  version: number;
  entities: EntityDescriptorInput[];
}

interface ManifestLike {
  id: string;
  version: string;
  profiles: ManifestProfile[];
}

export interface CreateInstallationInput {
  projectId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  config: unknown;
}

export interface BindDeviceInput {
  installationId: string;
  deviceId: string;
  profileId: string;
  profileVersion: number;
}

export async function createPluginInstallation(
  prisma: PrismaClient,
  input: CreateInstallationInput,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const snapshot = await getSnapshot(tx, input.pluginId, input.pluginVersion, input.manifestHash);
    const manifest = parseManifest(snapshot.canonicalManifest);
    if (manifest.id !== input.pluginId || manifest.version !== input.pluginVersion) {
      throw new Error("manifest identity does not match installation");
    }
    const installation = await tx.pluginInstallation.create({
      data: {
        projectId: input.projectId,
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        manifestHash: input.manifestHash,
        state: "enabled",
        config: toInputJson(input.config),
      },
      select: { id: true },
    });
    return installation;
  });
}

export async function bindDeviceToPluginInstallation(
  prisma: PrismaClient,
  input: BindDeviceInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Read the old binding only to discover every installation lock that may
    // be needed. It is re-read after the device lock before any write.
    const observedBinding = await tx.pluginDeviceBinding.findUnique({
      where: { deviceId: input.deviceId },
      select: { installationId: true },
    });
    const installationIds = [...new Set([
      input.installationId,
      ...(observedBinding ? [observedBinding.installationId] : []),
    ])].sort();
    // All lifecycle paths use installation(s, sorted) -> device -> registry.
    const installationRows = await tx.$queryRaw<Array<{ id: string; project_id: string; state: string }>>`
      SELECT id, project_id, state FROM plugin_installations
      WHERE id IN (${Prisma.join(installationIds.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY id
      FOR UPDATE
    `;
    const installationsById = new Map(installationRows.map((row) => [row.id, row]));
    const installationRow = installationsById.get(input.installationId);
    if (!installationRow) throw new Error("plugin installation not found");
    const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
      SELECT id, project_id FROM devices WHERE id = ${input.deviceId}::uuid FOR UPDATE
    `;
    const deviceRow = deviceRows[0];
    if (!deviceRow) throw new Error("device not found");
    if (deviceRow.project_id !== installationRow.project_id) throw new Error("device and installation belong to different projects");

    const lockedBinding = await tx.pluginDeviceBinding.findUnique({
      where: { deviceId: input.deviceId },
      select: { installationId: true },
    });
    if (lockedBinding && !installationsById.has(lockedBinding.installationId)) {
      throw new Error("device plugin binding changed concurrently; retry the bind");
    }

    const installation = await tx.pluginInstallation.findUniqueOrThrow({ where: { id: input.installationId } });
    if (installation.state !== "enabled") throw new Error("plugin installation is disabled");
    const snapshot = await getSnapshot(tx, installation.pluginId, installation.pluginVersion, installation.manifestHash);
    const profile = parseManifest(snapshot.canonicalManifest).profiles.find(
      (item) => item.id === input.profileId && item.version === input.profileVersion,
    );
    if (!profile) throw new Error("profile is not declared by the plugin manifest");

    await registerInstallationProfileEntitiesInTransaction(
      tx,
      input.installationId,
      profile.id,
      profile.version,
      profile.entities,
    );
    await tx.pluginDeviceBinding.upsert({
      where: { deviceId: input.deviceId },
      create: {
        deviceId: input.deviceId,
        installationId: input.installationId,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
      },
      update: {
        installationId: input.installationId,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
      },
    });
    await deprecateUnboundInstallationProfilesInTransaction(tx, input.installationId);
    if (lockedBinding && lockedBinding.installationId !== input.installationId) {
      await deprecateUnboundInstallationProfilesInTransaction(tx, lockedBinding.installationId);
    }
  });
}

export async function setPluginInstallationState(
  prisma: PrismaClient,
  installationId: string,
  state: "enabled" | "disabled",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM plugin_installations WHERE id = ${installationId}::uuid FOR UPDATE`;
    const result = await tx.pluginInstallation.updateMany({ where: { id: installationId }, data: { state } });
    if (result.count !== 1) throw new Error("plugin installation not found");
  });
}

export async function migratePluginInstallation(
  prisma: PrismaClient,
  installationId: string,
  pluginVersion: string,
  manifestHash: string,
  config: unknown,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM plugin_installations WHERE id = ${installationId}::uuid FOR UPDATE`;
    const installation = await tx.pluginInstallation.findUnique({ where: { id: installationId } });
    if (!installation) throw new Error("plugin installation not found");
    const snapshot = await getSnapshot(tx, installation.pluginId, pluginVersion, manifestHash);
    const manifest = parseManifest(snapshot.canonicalManifest);
    if (manifest.id !== installation.pluginId) throw new Error("manifest identity does not match installation");
    await tx.pluginInstallation.update({
      where: { id: installationId },
      data: { pluginVersion, manifestHash, config: toInputJson(config), state: "enabled" },
    });
    await tx.pluginEntityDescriptor.updateMany({
      where: { installationId },
      data: { deprecated: true },
    });
    const bindings = await tx.pluginDeviceBinding.findMany({ where: { installationId }, select: { profileId: true, profileVersion: true } });
    const profiles = new Map(bindings.map((binding) => [`${binding.profileId}\u0000${binding.profileVersion}`, binding]));
    for (const binding of profiles.values()) {
      const profile = manifest.profiles.find((item) => item.id === binding.profileId && item.version === binding.profileVersion);
      if (!profile) throw new Error(`bound profile ${binding.profileId}@${binding.profileVersion} is not declared by the target manifest`);
      await registerInstallationProfileEntitiesInTransaction(tx, installationId, profile.id, profile.version, profile.entities);
    }
    await deprecateUnboundInstallationProfilesInTransaction(tx, installationId);
  });
}

export async function reconcilePluginInstallation(
  prisma: PrismaClient,
  installationId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM plugin_installations WHERE id = ${installationId}::uuid FOR UPDATE`;
    const installation = await tx.pluginInstallation.findUniqueOrThrow({ where: { id: installationId } });
    const snapshot = await getSnapshot(tx, installation.pluginId, installation.pluginVersion, installation.manifestHash);
    const manifest = parseManifest(snapshot.canonicalManifest);
    const bindings = await tx.pluginDeviceBinding.findMany({ where: { installationId }, select: { profileId: true, profileVersion: true } });
    const profiles = new Map(bindings.map((binding) => [`${binding.profileId}\u0000${binding.profileVersion}`, binding]));
    for (const binding of profiles.values()) {
      const profile = manifest.profiles.find((item) => item.id === binding.profileId && item.version === binding.profileVersion);
      if (!profile) throw new Error(`bound profile ${binding.profileId}@${binding.profileVersion} is not declared by the installation manifest`);
      await registerInstallationProfileEntitiesInTransaction(tx, installationId, profile.id, profile.version, profile.entities);
    }
    await deprecateUnboundInstallationProfilesInTransaction(tx, installationId);
  });
}

export interface EntityStateResult {
  entityKey: string;
  value: unknown;
  quality: "good" | "bad" | "uncertain" | "stale" | "unknown";
  sourceTimestamp: string | null;
  ingestedAt: string;
  alarm: { level: "info" | "warning" | "critical"; code: string } | null;
}

export async function getPluginEntityState(
  prisma: PrismaClient,
  installationId: string,
  deviceId: string,
  entityKey: string,
): Promise<EntityStateResult | null> {
  const rows = await prisma.$queryRaw<Array<{
    entity_key: string;
    value: unknown;
    quality: string;
    source_timestamp: Date | null;
    ingested_at: Date;
    alarm_level: "info" | "warning" | "critical" | null;
    alarm_code: string | null;
  }>>`
    SELECT s.entity_key, s.value,
      CASE WHEN d.stale_after_seconds IS NOT NULL
             AND s.quality = 'good'
             AND s.ingested_at < CURRENT_TIMESTAMP - (d.stale_after_seconds * INTERVAL '1 second')
           THEN 'stale' ELSE s.quality END AS quality,
      s.source_timestamp, s.ingested_at, s.alarm_level, s.alarm_code
    FROM plugin_entity_states s
    JOIN plugin_entity_descriptors d
      ON d.installation_id = s.installation_id
     AND d.entity_key = s.entity_key
     AND d.revision = s.descriptor_revision
    JOIN plugin_device_bindings b
      ON b.device_id = s.device_id
     AND b.installation_id = s.installation_id
     AND b.profile_id = d.profile_id
     AND b.profile_version = d.profile_version
    WHERE s.installation_id = ${installationId}::uuid
      AND s.device_id = ${deviceId}::uuid
      AND s.entity_key = ${entityKey}
      AND d.deprecated = false
    ORDER BY d.created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    entityKey: row.entity_key,
    value: row.value,
    quality: row.quality as EntityStateResult["quality"],
    sourceTimestamp: row.source_timestamp?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    alarm: row.alarm_level && row.alarm_code ? { level: row.alarm_level, code: row.alarm_code } : null,
  };
}

async function getSnapshot(
  tx: Prisma.TransactionClient,
  pluginId: string,
  pluginVersion: string,
  manifestHash: string,
) {
  const snapshot = await tx.pluginManifestSnapshot.findUnique({
    where: { pluginId_pluginVersion: { pluginId, pluginVersion } },
  });
  if (!snapshot || snapshot.manifestHash.trim() !== manifestHash) throw new Error("plugin manifest snapshot not found or hash mismatch");
  return snapshot;
}

function parseManifest(value: unknown): ManifestLike {
  if (!value || typeof value !== "object") throw new Error("stored plugin manifest is invalid");
  const manifest = value as Partial<ManifestLike>;
  if (typeof manifest.id !== "string" || typeof manifest.version !== "string" || !Array.isArray(manifest.profiles)) {
    throw new Error("stored plugin manifest is invalid");
  }
  return manifest as ManifestLike;
}

function toInputJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}
