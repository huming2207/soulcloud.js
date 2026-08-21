/**
 * Plugin control-plane and device-plugin routes (§16, stage 3).
 *
 * Control plane:
 *   GET    /v1/plugins/catalog
 *   GET    /v1/projects/:projectId/plugin-installations
 *   POST   /v1/projects/:projectId/plugin-installations
 *   PATCH  /v1/plugin-installations/:installationId              config update
 *   POST   /v1/plugin-installations/:installationId/migrate      explicit version migration
 *   POST   /v1/plugin-installations/:installationId/disable
 *   POST   /v1/plugin-installations/:installationId/enable
 *
 * Device plugins:
 *   POST   /v1/devices/:deviceId/profile/dry-run           §3 high-risk preview
 *   PUT    /v1/devices/:deviceId/profile                   bind (audited)
 *   DELETE /v1/devices/:deviceId/profile                   unbind to generic (audited)
 *   GET    /v1/devices/:deviceId/plugin-view               binding + entities + states
 *   GET    /v1/devices/:deviceId/actions                   declarative action list
 *   POST   /v1/devices/:deviceId/actions/:action_id        encode → command queue
 *
 * Conventions: manifest metadata is imported from the trusted registry
 * (never worker code); every mutation writes an audit_events row in the
 * same transaction as the change; PluginSystemError kinds map to 4xx.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  PluginSystemError,
  enqueueBatch,
  recordAuditEvent,
  bindDeviceInTransaction,
  createInstallation,
  dryRunDeviceProfile,
  encodePluginAction,
  getDeviceEntityStates,
  getInstallation,
  listProjectInstallations,
  migrateInstallationInTransaction,
  resolveDeviceBinding,
  setInstallationState,
  updateInstallationConfig,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { pluginManifests } from "@soulcloud/plugins";
import { findProfile, validateActionInputSchema } from "@soulcloud/plugin-sdk";
import { authenticateRequest, handleApiError, userCanAccessProject, UuidParam } from "./validate";

const ConfigJsonSchema = z.record(z.string(), z.unknown());

const CreateInstallationBody = z
  .object({
    plugin_id: z.string().min(1).max(255),
    config_json: ConfigJsonSchema.optional(),
  })
  .strict();

const PatchInstallationBody = z
  .object({
    config_json: ConfigJsonSchema.optional(),
  })
  .strict();

const BindProfileBody = z
  .object({
    installation_id: UuidParam,
    profile_id: z.string().min(1).max(255),
    profile_version: z.coerce.number().int().positive(),
    configuration: ConfigJsonSchema.optional(),
  })
  .strict();

const DryRunBody = BindProfileBody.omit({ configuration: true }).strict();

const InvokeActionBody = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    delivery_timeout_seconds: z.coerce.number().int().positive().optional(),
  })
  .strict();

/** Maps typed plugin-system errors onto the API's error contract. */
function mapPluginError(
  error: unknown,
  set: { status?: number | string },
): { error: string; message: string } | undefined {
  if (!(error instanceof PluginSystemError)) return undefined;
  switch (error.kind) {
    case "device_not_bound":
    case "invalid_installation":
    case "unknown_action":
      set.status = 404;
      return { error: error.kind, message: error.message };
    case "unknown_plugin":
    case "unknown_profile":
    case "invalid_action_input":
    case "invalid_entity_update":
      set.status = 400;
      return { error: error.kind, message: error.message };
    case "version_mismatch":
    case "installation_not_enabled":
    case "binding_mismatch":
      set.status = 409;
      return { error: error.kind, message: error.message };
    default:
      console.error(`[soulcloud-api] plugin system failure: ${error.message}`);
      set.status = 500;
      return { error: "internal", message: "internal server error" };
  }
}

/** Deployed manifest lookup for a plugin id (404 when absent). */
function deployedManifest(
  pluginId: string,
): ReturnType<typeof pluginManifests.get> {
  return pluginManifests.get(pluginId);
}

export function createPluginRoutes(prisma: PrismaClient, auth: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    // ------------------------------------------------------------------
    // control plane
    // ------------------------------------------------------------------
    .get("/plugins/catalog", async ({ request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const catalog = [...pluginManifests.values()].map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        display_name: manifest.displayName ?? manifest.id,
        api_version: manifest.apiVersion,
        profiles: manifest.profiles.map((profile) => ({
          id: profile.id,
          version: profile.version,
          manufacturer: profile.manufacturer,
          model: profile.model,
          capabilities: profile.capabilities,
          entity_count: profile.entities.length,
        })),
        actions: manifest.actions.map((action) => ({
          id: action.id,
          wire_command: action.wire.command,
          schema_version: action.wire.schemaVersion,
        })),
      }));
      return { plugins: catalog };
    })
    .get("/projects/:projectId/plugin-installations", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      if (!UuidParam.safeParse(params.projectId).success) {
        set.status = 400;
        return { error: "invalid_request", message: "project id must be a uuid" };
      }
      if (!(await userCanAccessProject(prisma, authUser.user.id, params.projectId))) {
        set.status = 403;
        return { error: "forbidden", message: "not a member of this project" };
      }
      const installations = await listProjectInstallations(prisma, params.projectId);
      return {
        installations: installations.map((install) => ({
          id: install.id,
          plugin_id: install.pluginId,
          configured_plugin_version: install.configuredPluginVersion,
          state: install.state,
          config_json: install.configJson ?? {},
          device_count: install.deviceCount,
        })),
      };
    })
    .post("/projects/:projectId/plugin-installations", async ({ body, params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      if (!UuidParam.safeParse(params.projectId).success) {
        set.status = 400;
        return { error: "invalid_request", message: "project id must be a uuid" };
      }
      const parsed = CreateInstallationBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid_request", message: "invalid body" };
      }
      if (!(await userCanAccessProject(prisma, authUser.user.id, params.projectId))) {
        set.status = 403;
        return { error: "forbidden", message: "not a member of this project" };
      }
      const manifest = deployedManifest(parsed.data.plugin_id);
      if (!manifest) {
        set.status = 404;
        return { error: "unknown_plugin", message: `plugin "${parsed.data.plugin_id}" is not deployed` };
      }
      try {
        const installation = await prisma.$transaction(async (tx) => {
          const row = await createInstallation(tx, {
            projectId: params.projectId,
            manifest,
            configJson: parsed.data.config_json ?? {},
          });
          await recordAuditEvent(tx, {
            projectId: params.projectId,
            actorUserId: authUser.user.id,
            action: "installation.create",
            subjectType: "plugin_installation",
            subjectId: row.id,
            detail: { plugin_id: manifest.id, version: manifest.version },
          });
          return row;
        });
        set.status = 201;
        return {
          id: installation.id,
          plugin_id: installation.pluginId,
          configured_plugin_version: installation.configuredPluginVersion,
          state: installation.state,
          config_json: installation.configJson ?? {},
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .patch("/plugin-installations/:installationId", async ({ body, params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const parsed = PatchInstallationBody.safeParse(body);
      if (!parsed.success || parsed.data.config_json === undefined) {
        set.status = 400;
        return { error: "invalid_request", message: "config_json is required" };
      }
      try {
        const existing = await getInstallation(prisma, params.installationId);
        if (!(await userCanAccessProject(prisma, authUser.user.id, existing.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await updateInstallationConfig(tx, {
            installationId: params.installationId,
            configJson: parsed.data.config_json!,
          });
          await recordAuditEvent(tx, {
            projectId: row.projectId,
            actorUserId: authUser.user.id,
            action: "installation.update",
            subjectType: "plugin_installation",
            subjectId: row.id,
            detail: { config_keys: Object.keys(parsed.data.config_json!) },
          });
          return row;
        });
        return {
          id: updated.id,
          plugin_id: updated.pluginId,
          configured_plugin_version: updated.configuredPluginVersion,
          state: updated.state,
          config_json: updated.configJson ?? {},
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .post("/plugin-installations/:installationId/migrate", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      try {
        const existing = await getInstallation(prisma, params.installationId);
        if (!(await userCanAccessProject(prisma, authUser.user.id, existing.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        const manifest = deployedManifest(existing.pluginId);
        if (!manifest) {
          set.status = 409;
          return {
            error: "version_mismatch",
            message: `plugin ${existing.pluginId} is not present in the deployed registry`,
          };
        }
        const result = await prisma.$transaction(async (tx) => {
          const migrated = await migrateInstallationInTransaction(tx, {
            installationId: params.installationId,
            manifest,
          });
          await recordAuditEvent(tx, {
            projectId: migrated.installation.projectId,
            actorUserId: authUser.user.id,
            action: "installation.migrate",
            subjectType: "plugin_installation",
            subjectId: params.installationId,
            detail: {
              from_version: existing.configuredPluginVersion,
              to_version: manifest.version,
              reconciled_devices: migrated.reconcile?.devices ?? 0,
            },
          });
          return migrated;
        });
        return {
          id: result.installation.id,
          plugin_id: result.installation.pluginId,
          configured_plugin_version: result.installation.configuredPluginVersion,
          state: result.installation.state,
          reconciled_devices: result.reconcile?.devices ?? 0,
          deprecated_registry_rows: result.reconcile?.deprecatedRegistryRows ?? 0,
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .post("/plugin-installations/:installationId/disable", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      return mutateInstallationState(prisma, auth, authUser.user.id, params.installationId, "disabled", set);
    })
    .post("/plugin-installations/:installationId/enable", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      return mutateInstallationState(prisma, auth, authUser.user.id, params.installationId, "enabled", set);
    })
    // ------------------------------------------------------------------
    // device plugins
    // ------------------------------------------------------------------
    .post("/devices/:deviceId/profile/dry-run", async ({ body, params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const parsed = DryRunBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid_request", message: "invalid body" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        const install = await getInstallation(prisma, parsed.data.installation_id);
        const manifest = deployedManifest(install.pluginId);
        if (!manifest) {
          set.status = 409;
          return {
            error: "version_mismatch",
            message: `plugin ${install.pluginId} is not present in the deployed registry`,
          };
        }
        const report = await dryRunDeviceProfile(prisma, {
          deviceId: params.deviceId,
          installationId: parsed.data.installation_id,
          profileId: parsed.data.profile_id,
          profileVersion: parsed.data.profile_version,
          manifest,
        });
        return {
          current: report.current && {
            installation_id: report.current.installationId,
            plugin_id: report.current.pluginId,
            profile_id: report.current.profileId,
            profile_version: report.current.profileVersion,
          },
          target: {
            installation_id: report.target.installationId,
            plugin_id: report.target.pluginId,
            profile_id: report.target.profileId,
            profile_version: report.target.profileVersion,
          },
          checks: report.checks,
          entity_changes: {
            added: report.entityChanges.added,
            removed: report.entityChanges.removed,
            changed: report.entityChanges.changed,
          },
          blocking_reasons: report.blockingReasons,
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .put("/devices/:deviceId/profile", async ({ body, params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const parsed = BindProfileBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid_request", message: "invalid body" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        const install = await getInstallation(prisma, parsed.data.installation_id);
        const manifest = deployedManifest(install.pluginId);
        if (!manifest) {
          set.status = 409;
          return {
            error: "version_mismatch",
            message: `plugin ${install.pluginId} is not present in the deployed registry`,
          };
        }
        const binding = await prisma.$transaction(async (tx) => {
          const bound = await bindDeviceInTransaction(tx, {
            deviceId: params.deviceId,
            installationId: parsed.data.installation_id,
            profileId: parsed.data.profile_id,
            profileVersion: parsed.data.profile_version,
            configuration: parsed.data.configuration,
            manifest,
          });
          await recordAuditEvent(tx, {
            projectId: device.projectId,
            actorUserId: authUser.user.id,
            action: "device.profile.bind",
            subjectType: "device",
            subjectId: params.deviceId,
            detail: {
              installation_id: parsed.data.installation_id,
              plugin_id: bound.pluginId,
              profile_id: bound.profileId,
              profile_version: bound.profileVersion,
            },
          });
          return bound;
        });
        return {
          device_id: binding.deviceId,
          installation_id: binding.installationId,
          plugin_id: binding.pluginId,
          profile_id: binding.profileId,
          profile_version: binding.profileVersion,
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .delete("/devices/:deviceId/profile", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true, pluginId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        if (device.pluginId === null) {
          set.status = 409;
          return { error: "binding_mismatch", message: "device already uses the builtin generic profile" };
        }
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE devices
            SET plugin_installation_id = NULL, plugin_id = NULL,
                profile_id = NULL, profile_version = NULL,
                profile_configuration = NULL
            WHERE id = ${params.deviceId}
          `;
          await recordAuditEvent(tx, {
            projectId: device.projectId,
            actorUserId: authUser.user.id,
            action: "device.profile.unbind",
            subjectType: "device",
            subjectId: params.deviceId,
            detail: { previous_plugin_id: device.pluginId },
          });
        });
        return { device_id: params.deviceId, plugin_id: "soulcloud.generic", profile_id: "generic", profile_version: 1 };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .get("/devices/:deviceId/plugin-view", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        const binding = await resolveDeviceBinding(prisma, params.deviceId);
        const manifest = deployedManifest(binding.pluginId) ?? null;
        const profile =
          manifest !== null
            ? findProfile(manifest, binding.profileId, binding.profileVersion) ?? null
            : null;
        const states = await getDeviceEntityStates(prisma, params.deviceId);
        const stateByKey = new Map(
          states.filter((s) => s.ingestedAt !== null).map((s) => [s.entityKey, s]),
        );
        const entities = (profile?.entities ?? []).map((descriptor) => ({
          descriptor: {
            key: descriptor.key,
            value_type: descriptor.valueType,
            access: descriptor.access,
            category: descriptor.category,
            unit: descriptor.unit ?? null,
            enum_values: descriptor.enumValues ?? null,
            stale_after_seconds: descriptor.staleAfterSeconds ?? null,
            history: descriptor.history,
            display_name: descriptor.displayName ?? null,
          },
          state: stateByKey.get(descriptor.key) ?? null,
        }));
        return {
          binding: {
            installation_id: binding.installationId,
            plugin_id: binding.pluginId,
            plugin_version: manifest?.version ?? null,
            profile_id: binding.profileId,
            profile_version: binding.profileVersion,
          },
          entities,
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .get("/devices/:deviceId/actions", async ({ params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        const binding = await resolveDeviceBinding(prisma, params.deviceId);
        const manifest = deployedManifest(binding.pluginId) ?? null;
        const actions = (manifest?.actions ?? [])
          .filter((action) => validateActionInputSchema(action) === null)
          .map((action) => ({
            id: action.id,
            input_schema: action.inputSchema,
            wire_command: action.wire.command,
            schema_version: action.wire.schemaVersion,
          }));
        return { actions };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    })
    .post("/devices/:deviceId/actions/:action_id", async ({ body, params, request, set }) => {
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const parsed = InvokeActionBody.safeParse(body ?? {});
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid_request", message: "invalid body" };
      }
      try {
        const device = await prisma.device.findUnique({
          where: { id: params.deviceId },
          select: { projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_bound", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        const binding = await resolveDeviceBinding(prisma, params.deviceId);
        const manifest = deployedManifest(binding.pluginId);
        if (!manifest) {
          set.status = 409;
          return {
            error: "version_mismatch",
            message: `plugin ${binding.pluginId} is not present in the deployed registry`,
          };
        }
        if (binding.installationId !== null) {
          const install = await getInstallation(prisma, binding.installationId);
          if (install.state !== "enabled") {
            set.status = 409;
            return {
              error: "installation_not_enabled",
              message: `installation ${install.id} is ${install.state}`,
            };
          }
        }
        const encoded = encodePluginAction({
          manifest,
          actionId: params.action_id,
          input: parsed.data.input ?? {},
        });
        // enqueueBatch owns its own transaction (sequence snapshotting), so
        // the audit record cannot share it; a failed audit write must not
        // un-queue an already accepted command — log and continue.
        const batch = await enqueueBatch(prisma, [params.deviceId], encoded.command, {
          deliveryTimeoutSeconds: parsed.data.delivery_timeout_seconds,
        });
        try {
          await recordAuditEvent(prisma, {
            projectId: device.projectId,
            actorUserId: authUser.user.id,
            action: "device.action.invoke",
            subjectType: "device",
            subjectId: params.deviceId,
            detail: {
              plugin_id: binding.pluginId,
              action_id: params.action_id,
              wire_command: encoded.command.cmd,
              schema_version: encoded.schemaVersion,
              batch_id: batch.id,
            },
          });
        } catch (auditError) {
          console.error(
            `[soulcloud-api] action audit write failed (command ${batch.id} already queued): ${(auditError as Error).message}`,
          );
        }
        set.status = 202;
        return {
          batch_id: batch.id,
          device_count: batch.deviceCount,
          wire_command: encoded.command.cmd,
          schema_version: encoded.schemaVersion,
        };
      } catch (error) {
        return mapPluginError(error, set) ?? handleApiError(error, set);
      }
    });
}

async function mutateInstallationState(
  prisma: PrismaClient,
  auth: JwtConfig,
  userId: string,
  installationId: string,
  state: "enabled" | "disabled",
  set: { status?: number | string },
): Promise<unknown> {
  void auth;
  try {
    const existing = await getInstallation(prisma, installationId);
    if (!(await userCanAccessProject(prisma, userId, existing.projectId))) {
      set.status = 403;
      return { error: "forbidden", message: "not a member of this project" };
    }
    const updated = await prisma.$transaction(async (tx) => {
      const row = await setInstallationState(tx, {
        installationId,
        state,
      });
      await recordAuditEvent(tx, {
        projectId: row.projectId,
        actorUserId: userId,
        action: state === "disabled" ? "installation.disable" : "installation.enable",
        subjectType: "plugin_installation",
        subjectId: installationId,
        detail: { previous_state: existing.state },
      });
      return row;
    });
    return {
      id: updated.id,
      plugin_id: updated.pluginId,
      configured_plugin_version: updated.configuredPluginVersion,
      state: updated.state,
    };
  } catch (error) {
    return mapPluginError(error, set) ?? handleApiError(error, set);
  }
}
