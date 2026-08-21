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

import type { DbExecutor } from "../db";
import { PluginSystemError } from "./errors";
import type { PluginManifest } from "@soulcloud/plugin-sdk";

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
 */
export async function bindDeviceToInstallation(
  prisma: DbExecutor,
  params: {
    deviceId: string;
    installationId: string;
    profileId: string;
    profileVersion: number;
    configuration?: unknown;
  },
): Promise<DeviceBinding> {
  const installation = await prisma.$queryRaw<InstallationRow[]>`
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
  const device = await prisma.$queryRaw<{ project_id: string }[]>`
    SELECT project_id FROM devices WHERE id = ${params.deviceId} LIMIT 1
  `;
  if (device[0]?.project_id !== install.projectId) {
    throw new PluginSystemError(
      "binding_mismatch",
      `device ${params.deviceId} belongs to a different project than installation ${install.id}`,
    );
  }
  await prisma.$executeRaw`
    UPDATE devices
    SET plugin_installation_id = ${params.installationId},
        plugin_id = ${install.pluginId},
        profile_id = ${params.profileId},
        profile_version = ${params.profileVersion},
        profile_configuration = ${JSON.stringify(params.configuration ?? {})}::jsonb
    WHERE id = ${params.deviceId}
  `;
  const binding = await resolveDeviceBinding(prisma, params.deviceId);
  if (binding.installationId !== params.installationId) {
    throw new PluginSystemError(
      "binding_mismatch",
      `device ${params.deviceId} is not in the installation's project`,
    );
  }
  return binding;
}
