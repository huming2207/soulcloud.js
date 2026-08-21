/**
 * Plugin installations (§3) and device binding resolution (§6.3).
 *
 * Key rules:
 *   - `configured_plugin_version` must exactly match the deployed registry
 *     version. A mismatch is an `error` installation: never auto-upgrade,
 *     never auto-downgrade.
 *   - Event routing is DERIVED from the device's database binding; the
 *     device never chooses the plugin (§5).
 *   - Devices with no binding map to the builtin soulcloud.generic profile
 *     and keep their existing protocol behaviour untouched.
 */

import { Prisma, type DbExecutor, type PrismaClient } from "../db";
import { PluginSystemError } from "./errors";
import { canonicalDescriptor, registerDeviceEntities } from "./entity";
import { findProfile, type PluginManifest } from "@soulcloud/plugin-sdk";

export const BUILTIN_PLUGIN_ID = "soulcloud.generic";
export const BUILTIN_PROFILE_ID = "generic";
export const BUILTIN_PROFILE_VERSION = 1;

export type InstallationState =
  | "enabled"
  | "draining"
  | "disabled"
  | "error";

export interface InstallationRow {
  id: string;
  projectId: string;
  pluginId: string;
  configuredPluginVersion: string;
  state: InstallationState;
  configJson: unknown;
}

export interface DeviceBinding {
  deviceId: string;
  deviceUid: string;
  pluginId: string;
  profileId: string;
  profileVersion: number;
  /** Null for the builtin generic profile. */
  installationId: string | null;
}

interface DeviceRow {
  id: string;
  device_uid: string;
  plugin_installation_id: string | null;
  plugin_id: string | null;
  profile_id: string | null;
  profile_version: number | null;
}

/**
 * Resolves a device's plugin binding. Unbound devices map to the builtin
 * generic profile — existing devices keep their current behaviour (§3).
 */
export async function resolveDeviceBinding(
  prisma: DbExecutor,
  deviceId: string,
): Promise<DeviceBinding> {
  const rows = await prisma.$queryRaw<DeviceRow[]>`
    SELECT id, device_uid, plugin_installation_id, plugin_id, profile_id, profile_version
    FROM devices
    WHERE id = ${deviceId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new PluginSystemError(
      "device_not_bound",
      `device ${deviceId} does not exist`,
    );
  }
  if (row.plugin_id === null || row.profile_id === null || row.profile_version === null) {
    return {
      deviceId: row.id,
      deviceUid: row.device_uid,
      pluginId: BUILTIN_PLUGIN_ID,
      profileId: BUILTIN_PROFILE_ID,
      profileVersion: BUILTIN_PROFILE_VERSION,
      installationId: null,
    };
  }
  return {
    deviceId: row.id,
    deviceUid: row.device_uid,
    pluginId: row.plugin_id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    installationId: row.plugin_installation_id,
  };
}

/**
 * Creates an installation. The plugin must exist in the deployed registry
 * and the configured version must match it exactly (§3).
 */
export async function createInstallation(
  prisma: DbExecutor,
  params: {
    projectId: string;
    manifest: PluginManifest;
    configJson?: unknown;
  },
): Promise<InstallationRow> {
  const rows = await prisma.$queryRaw<InstallationRow[]>`
    INSERT INTO plugin_installations (id, project_id, plugin_id, configured_plugin_version, state, config_json, updated_at)
    VALUES (${crypto.randomUUID()}, ${params.projectId}, ${params.manifest.id},
            ${params.manifest.version}, 'enabled', ${JSON.stringify(params.configJson ?? {})}::jsonb, now())
    RETURNING id, project_id AS "projectId", plugin_id AS "pluginId",
              configured_plugin_version AS "configuredPluginVersion",
              state, config_json AS "configJson"
  `;
  const row = rows[0];
  if (!row) throw new PluginSystemError("database", "installation insert returned no row");
  return row;
}

/**
 * Binds a device to a plugin installation + profile (the high-risk
 * operation §3 reserves for its own permission and audit path — the
 * permission check itself is API-layer, stage 3).
 *
 * The deployed manifest is REQUIRED (H2): the profile must be declared by
 * the installation's plugin at exactly the given version, and the
 * profile's entity descriptors are registered for the device in the same
 * transaction. Binding without registry rows would make every later
 * entity update dead-letter as unknown_entity.
 */
export async function bindDeviceToInstallation(
  prisma: PrismaClient,
  params: {
    deviceId: string;
    installationId: string;
    profileId: string;
    profileVersion: number;
    configuration?: unknown;
    /** Deployed manifest that must own the profile being bound. */
    manifest: PluginManifest;
  },
): Promise<DeviceBinding> {
  return prisma.$transaction((tx) =>
    bindDeviceInTransaction(tx, params),
  );
}

/**
 * Transaction-core of {@link bindDeviceToInstallation}: callers that need
 * the binding and further writes (audit record) in ONE transaction pass
 * their transaction client directly.
 */
export async function bindDeviceInTransaction(
  tx: DbExecutor,
  params: {
    deviceId: string;
    installationId: string;
    profileId: string;
    profileVersion: number;
    configuration?: unknown;
    manifest: PluginManifest;
  },
): Promise<DeviceBinding> {
    const installation = await tx.$queryRaw<InstallationRow[]>`
      SELECT id, project_id AS "projectId", plugin_id AS "pluginId",
             configured_plugin_version AS "configuredPluginVersion",
             state, config_json AS "configJson"
      FROM plugin_installations WHERE id = ${params.installationId} LIMIT 1
    `;
    const install = installation[0];
    if (!install) {
      throw new PluginSystemError(
        "invalid_installation",
        `installation ${params.installationId} does not exist`,
      );
    }
    if (install.state !== "enabled") {
      throw new PluginSystemError(
        "installation_not_enabled",
        `installation ${install.id} is ${install.state}, not enabled`,
      );
    }
    if (install.pluginId !== params.manifest.id) {
      throw new PluginSystemError(
        "unknown_plugin",
        `manifest describes plugin ${params.manifest.id}, but installation ${install.id} belongs to ${install.pluginId}`,
      );
    }
    const profile = findProfile(
      params.manifest,
      params.profileId,
      params.profileVersion,
    );
    if (!profile) {
      throw new PluginSystemError(
        "unknown_profile",
        `plugin ${params.manifest.id} does not declare profile ${params.profileId}@${params.profileVersion}`,
      );
    }
    const device = await tx.$queryRaw<{ project_id: string }[]>`
      SELECT project_id FROM devices WHERE id = ${params.deviceId} LIMIT 1
    `;
    if (device[0]?.project_id !== install.projectId) {
      throw new PluginSystemError(
        "binding_mismatch",
        `device ${params.deviceId} belongs to a different project than installation ${install.id}`,
      );
    }
    await tx.$executeRaw`
      UPDATE devices
      SET plugin_installation_id = ${params.installationId},
          plugin_id = ${install.pluginId},
          profile_id = ${params.profileId},
          profile_version = ${params.profileVersion},
          profile_configuration = ${JSON.stringify(params.configuration ?? {})}::jsonb
      WHERE id = ${params.deviceId}
    `;
    await registerDeviceEntities(tx, params.deviceId, install.pluginId, profile);
    const binding = await resolveDeviceBinding(tx, params.deviceId);
    if (binding.installationId !== params.installationId) {
      throw new PluginSystemError(
        "binding_mismatch",
        `device ${params.deviceId} is not in the installation's project`,
      );
    }
    return binding;
}

export interface ReconcileInstallationResult {
  /** Devices whose entity registry rows were refreshed. */
  devices: number;
  /** Registry rows deprecated because their key left every bound profile. */
  deprecatedRegistryRows: number;
  /** Bound profiles absent from the deployed manifest (left untouched). */
  missingProfiles: string[];
}

/**
 * Re-aligns every device bound to one installation with the DEPLOYED
 * manifest (§4.1, H2 reconcile path for plugin upgrades):
 *   - canonical descriptor changes create revision N+1 and registry rows
 *     repoint at it (history keeps referencing the old revision),
 *   - entity keys that left every bound profile have their registry rows
 *     marked deprecated — history is never deleted or re-interpreted,
 *   - profiles missing from the manifest are reported, not guessed.
 *
 * Requires manifest.version === configured_plugin_version: reconciling
 * against any other version would silently change device semantics (§3).
 */
export async function reconcileInstallationDevices(
  prisma: DbExecutor,
  params: {
    installationId: string;
    manifest: PluginManifest;
  },
): Promise<ReconcileInstallationResult> {
  const installations = await prisma.$queryRaw<InstallationRow[]>`
    SELECT id, project_id AS "projectId", plugin_id AS "pluginId",
           configured_plugin_version AS "configuredPluginVersion",
           state, config_json AS "configJson"
    FROM plugin_installations WHERE id = ${params.installationId} LIMIT 1
  `;
  const install = installations[0];
  if (!install) {
    throw new PluginSystemError(
      "invalid_installation",
      `installation ${params.installationId} does not exist`,
    );
  }
  if (install.pluginId !== params.manifest.id) {
    throw new PluginSystemError(
      "unknown_plugin",
      `manifest describes plugin ${params.manifest.id}, but installation ${install.id} belongs to ${install.pluginId}`,
    );
  }
  if (install.configuredPluginVersion !== params.manifest.version) {
    throw new PluginSystemError(
      "version_mismatch",
      `installation ${install.id} is configured for ${install.configuredPluginVersion}, deployed manifest is ${params.manifest.version}`,
    );
  }

  const groups = await prisma.$queryRaw<
    { profile_id: string; profile_version: number }[]
  >`
    SELECT DISTINCT profile_id, profile_version
    FROM devices
    WHERE plugin_installation_id = ${params.installationId}
      AND plugin_id = ${params.manifest.id}
      AND profile_id IS NOT NULL AND profile_version IS NOT NULL
  `;

  const declaredKeys = new Set<string>();
  const missingProfiles: string[] = [];
  let devices = 0;
  for (const group of groups) {
    const profile = findProfile(
      params.manifest,
      group.profile_id,
      group.profile_version,
    );
    if (!profile) {
      missingProfiles.push(`${group.profile_id}@${group.profile_version}`);
      continue;
    }
    for (const entity of profile.entities) declaredKeys.add(entity.key);
    const deviceRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM devices
      WHERE plugin_installation_id = ${params.installationId}
        AND profile_id = ${group.profile_id}
        AND profile_version = ${group.profile_version}
    `;
    for (const deviceRow of deviceRows) {
      await registerDeviceEntities(prisma, deviceRow.id, params.manifest.id, profile);
      devices += 1;
    }
  }

  let deprecatedRegistryRows = 0;
  if (groups.length > 0 && missingProfiles.length < groups.length) {
    const keyList = [...declaredKeys];
    deprecatedRegistryRows = await prisma.$executeRaw`
      UPDATE entity_registry er
      SET deprecated = true
      FROM devices d
      WHERE d.id = er.device_id
        AND d.plugin_installation_id = ${params.installationId}
        AND er.plugin_id = ${params.manifest.id}
        AND er.deprecated = false
        ${keyList.length > 0
          ? Prisma.sql`AND er.entity_key NOT IN (${Prisma.join(keyList)})`
          : Prisma.empty}
    `;
  }
  return { devices, deprecatedRegistryRows, missingProfiles };
}

// ---------------------------------------------------------------------------
// Installation lifecycle (stage 3 control plane, §16)
// ---------------------------------------------------------------------------

/**
 * Replaces the installation configuration. The value must be a JSON
 * object; per-installation schema validation arrives with profile
 * `configurationSchema` (§3) and is currently the caller's duty.
 */
export async function updateInstallationConfig(
  prisma: DbExecutor,
  params: {
    installationId: string;
    configJson: Record<string, unknown>;
  },
): Promise<InstallationRow> {
  const rows = await prisma.$queryRaw<InstallationRow[]>`
    UPDATE plugin_installations
    SET config_json = ${JSON.stringify(params.configJson)}::jsonb, updated_at = now()
    WHERE id = ${params.installationId}
    RETURNING id, project_id AS "projectId", plugin_id AS "pluginId",
              configured_plugin_version AS "configuredPluginVersion",
              state, config_json AS "configJson"
  `;
  const row = rows[0];
  if (!row) {
    throw new PluginSystemError(
      "invalid_installation",
      `installation ${params.installationId} does not exist`,
    );
  }
  return row;
}

/**
 * Enables or disables an installation. `error`/`draining` are
 * system-managed states: an errored installation must migrate (or be
 * disabled) instead of being force-enabled blind.
 */
export async function setInstallationState(
  prisma: DbExecutor,
  params: {
    installationId: string;
    state: "enabled" | "disabled";
  },
): Promise<InstallationRow> {
  const current = await prisma.$queryRaw<{ state: string }[]>`
    SELECT state FROM plugin_installations WHERE id = ${params.installationId} LIMIT 1
  `;
  const from = current[0]?.state;
  if (!from) {
    throw new PluginSystemError(
      "invalid_installation",
      `installation ${params.installationId} does not exist`,
    );
  }
  if (params.state === "enabled" && from === "error") {
    throw new PluginSystemError(
      "installation_not_enabled",
      `installation ${params.installationId} is in error state; migrate it to the deployed version first`,
    );
  }
  if (from === params.state) return await getInstallation(prisma, params.installationId);
  const rows = await prisma.$queryRaw<InstallationRow[]>`
    UPDATE plugin_installations
    SET state = ${params.state}, error_detail = NULL, updated_at = now()
    WHERE id = ${params.installationId}
    RETURNING id, project_id AS "projectId", plugin_id AS "pluginId",
              configured_plugin_version AS "configuredPluginVersion",
              state, config_json AS "configJson"
  `;
  const row = rows[0];
  if (!row) {
    throw new PluginSystemError(
      "invalid_installation",
      `installation ${params.installationId} does not exist`,
    );
  }
  return row;
}

export async function getInstallation(
  prisma: DbExecutor,
  installationId: string,
): Promise<InstallationRow> {
  const rows = await prisma.$queryRaw<InstallationRow[]>`
    SELECT id, project_id AS "projectId", plugin_id AS "pluginId",
           configured_plugin_version AS "configuredPluginVersion",
           state, config_json AS "configJson"
    FROM plugin_installations WHERE id = ${installationId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new PluginSystemError(
      "invalid_installation",
      `installation ${installationId} does not exist`,
    );
  }
  return row;
}

export interface InstallationListRow extends InstallationRow {
  deviceCount: number;
}

/** Installations of one project with their bound-device counts. */
export async function listProjectInstallations(
  prisma: DbExecutor,
  projectId: string,
): Promise<InstallationListRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      project_id: string;
      plugin_id: string;
      configured_plugin_version: string;
      state: string;
      config_json: unknown;
      device_count: bigint;
    }>
  >`
    SELECT pi.id, pi.project_id, pi.plugin_id, pi.configured_plugin_version,
           pi.state, pi.config_json,
           (SELECT COUNT(*)::bigint FROM devices d WHERE d.plugin_installation_id = pi.id) AS device_count
    FROM plugin_installations pi
    WHERE pi.project_id = ${projectId}
    ORDER BY pi.created_at, pi.id
  `;
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    pluginId: row.plugin_id,
    configuredPluginVersion: row.configured_plugin_version,
    state: row.state as InstallationState,
    configJson: row.config_json,
    deviceCount: Number(row.device_count),
  }));
}

export interface MigrationResult {
  installation: InstallationRow;
  /** False when the configured version already matched the deployment. */
  migrated: boolean;
  reconcile: ReconcileInstallationResult | null;
}

/**
 * Migrates an installation to the DEPLOYED manifest version (§3: explicit
 * migration, never silent). Version change, state recovery from `error`
 * and the entity-registry reconcile commit in ONE transaction — devices
 * are never left pointing at descriptors the new version does not declare.
 *
 * @throws {PluginSystemError} invalid_installation / unknown_plugin /
 * version_mismatch when already on the deployed version.
 */
export async function migrateInstallationInTransaction(
  tx: DbExecutor,
  params: {
    installationId: string;
    manifest: PluginManifest;
  },
): Promise<MigrationResult> {
  const install = await getInstallation(tx, params.installationId);
  if (install.pluginId !== params.manifest.id) {
    throw new PluginSystemError(
      "unknown_plugin",
      `manifest describes plugin ${params.manifest.id}, but installation ${install.id} belongs to ${install.pluginId}`,
    );
  }
  if (install.configuredPluginVersion === params.manifest.version) {
    throw new PluginSystemError(
      "version_mismatch",
      `installation ${install.id} is already configured for deployed version ${params.manifest.version}`,
    );
  }
  const updated = await tx.$queryRaw<InstallationRow[]>`
    UPDATE plugin_installations
    SET configured_plugin_version = ${params.manifest.version},
        state = 'enabled',
        error_detail = NULL,
        updated_at = now()
    WHERE id = ${params.installationId}
    RETURNING id, project_id AS "projectId", plugin_id AS "pluginId",
              configured_plugin_version AS "configuredPluginVersion",
              state, config_json AS "configJson"
  `;
  const row = updated[0]!;
  const reconcile = await reconcileInstallationDevices(tx, {
    installationId: params.installationId,
    manifest: params.manifest,
  });
  return { installation: row, migrated: true, reconcile };
}

// ---------------------------------------------------------------------------
// Profile dry-run (§16 POST /v1/devices/:id/profile/dry-run)
// ---------------------------------------------------------------------------

export interface ProfileDryRun {
  current: {
    installationId: string | null;
    pluginId: string;
    profileId: string;
    profileVersion: number;
  } | null;
  target: {
    installationId: string;
    pluginId: string;
    profileId: string;
    profileVersion: number;
  };
  checks: {
    installationEnabled: boolean;
    versionMatch: boolean;
    projectMatches: boolean;
    profileDeclared: boolean;
  };
  /**
   * Target entity keys vs this device's CURRENT registry rows for the
   * target plugin: added = new keys, removed = keys that would disappear,
   * changed = keys whose descriptor canonical form differs.
   */
  entityChanges: { added: string[]; removed: string[]; changed: string[] };
  /** Non-empty means PUT /profile would be rejected as-is. */
  blockingReasons: string[];
}

/**
 * Validates a would-be profile binding WITHOUT applying it (§3: high-risk
 * operation requires dry-run). Missing device/installation still throw —
 * those are caller errors, not binding risks.
 */
export async function dryRunDeviceProfile(
  prisma: DbExecutor,
  params: {
    deviceId: string;
    installationId: string;
    profileId: string;
    profileVersion: number;
    manifest: PluginManifest;
  },
): Promise<ProfileDryRun> {
  const binding = await resolveDeviceBinding(prisma, params.deviceId);
  const install = await getInstallation(prisma, params.installationId);
  const profile = findProfile(
    params.manifest,
    params.profileId,
    params.profileVersion,
  );

  const checks = {
    installationEnabled: install.state === "enabled",
    versionMatch:
      install.pluginId === params.manifest.id &&
      install.configuredPluginVersion === params.manifest.version,
    projectMatches: true,
    profileDeclared: profile !== null && install.pluginId === params.manifest.id,
  };
  const deviceProject = await prisma.$queryRaw<{ project_id: string }[]>`
    SELECT project_id FROM devices WHERE id = ${params.deviceId} LIMIT 1
  `;
  checks.projectMatches = deviceProject[0]?.project_id === install.projectId;

  // Entity diff against the target plugin's registry rows for this device.
  const registryRows = await prisma.$queryRaw<
    { entity_key: string; descriptor: unknown }[]
  >`
    SELECT er.entity_key, rev.descriptor
    FROM entity_registry er
    INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
    WHERE er.device_id = ${params.deviceId}
      AND er.plugin_id = ${install.pluginId}
  `;
  const currentByKey = new Map(registryRows.map((r) => [r.entity_key, r.descriptor]));
  const targetKeys = (profile?.entities ?? []).map((e) => e.key);
  const targetByKey = new Map(
    (profile?.entities ?? []).map((e) => [e.key, canonicalDescriptor(e)]),
  );
  const added = targetKeys.filter((key) => !currentByKey.has(key));
  const removed = [...currentByKey.keys()].filter((key) => !targetByKey.has(key));
  const changed = [...targetByKey.entries()]
    .filter(([key, canonical]) => {
      const currentDescriptor = currentByKey.get(key);
      return (
        currentDescriptor !== undefined &&
        canonicalDescriptor(currentDescriptor as never) !== canonical
      );
    })
    .map(([key]) => key);

  const blockingReasons: string[] = [];
  if (!checks.profileDeclared) blockingReasons.push("profile_not_declared");
  if (!checks.versionMatch) blockingReasons.push("version_mismatch");
  if (!checks.projectMatches) blockingReasons.push("project_mismatch");
  if (!checks.installationEnabled) blockingReasons.push("installation_not_enabled");

  return {
    current: {
      installationId: binding.installationId,
      pluginId: binding.pluginId,
      profileId: binding.profileId,
      profileVersion: binding.profileVersion,
    },
    target: {
      installationId: params.installationId,
      pluginId: install.pluginId,
      profileId: params.profileId,
      profileVersion: params.profileVersion,
    },
    checks,
    entityChanges: { added, removed, changed },
    blockingReasons,
  };
}
