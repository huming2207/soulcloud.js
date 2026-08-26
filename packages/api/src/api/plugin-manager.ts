import { signPluginUiSession, type JwtConfig, type PrismaClient } from "@soulcloud/core";
import { Elysia } from "elysia";
import type { PluginManagerOptions } from "./app";
import { authenticateRequest, userCanAccessProject } from "./validate";
import { z } from "zod";

class PluginManagerUnavailableError extends Error {}

async function fetchCatalog(options: PluginManagerOptions): Promise<unknown> {
  if (!options.serviceToken) throw new PluginManagerUnavailableError("plugin manager service credential is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 5_000);
  try {
    const base = options.internalUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/internal/plugins/catalog`, {
      headers: { authorization: `Bearer ${options.serviceToken}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new PluginManagerUnavailableError(`plugin manager returned ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof PluginManagerUnavailableError) throw error;
    throw new PluginManagerUnavailableError("plugin manager is unavailable");
  } finally { clearTimeout(timer); }
}

async function callManager(options: PluginManagerOptions, path: string, body: unknown): Promise<{ status: number; value: unknown }> {
  if (!options.serviceToken) throw new PluginManagerUnavailableError("plugin manager service credential is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 5_000);
  try {
    const response = await fetch(`${options.internalUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.serviceToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const value = await response.json().catch(() => null);
    return { status: response.status, value };
  } catch {
    throw new PluginManagerUnavailableError("plugin manager is unavailable");
  } finally { clearTimeout(timer); }
}

async function callManagerBinary(options: PluginManagerOptions, path: string, request: Request, headers: Record<string, string>): Promise<{ status: number; value: unknown }> {
  if (!options.serviceToken) throw new PluginManagerUnavailableError("plugin manager service credential is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.uploadTimeoutMs ?? Math.max(options.requestTimeoutMs ?? 5_000, 60_000));
  try {
    const response = await fetch(`${options.internalUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.serviceToken}`, "content-type": request.headers.get("content-type") ?? "application/octet-stream", ...(request.headers.get("content-length") ? { "content-length": request.headers.get("content-length")! } : {}), ...headers },
      body: request.body,
      signal: controller.signal,
    });
    const value = await response.json().catch(() => null);
    return { status: response.status, value };
  } catch {
    throw new PluginManagerUnavailableError("plugin manager is unavailable");
  } finally { clearTimeout(timer); }
}

export function pluginManagerOperationTimeoutMs(requestTimeoutMs = 5_000): number {
  return Math.min(30_000, Math.max(100, requestTimeoutMs - 1_000));
}

const installationBody = z.object({ project_id: z.string().uuid(), plugin_id: z.string().min(1).max(128), plugin_version: z.string().min(1).max(128), manifest_hash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown().optional() }).strict();
const bindingBody = z.object({ device_id: z.string().uuid(), profile_id: z.string().min(1).max(128), profile_version: z.number().int().positive() }).strict();
export const pluginActionRequestBody = z.object({ device_id: z.string().uuid(), input: z.unknown(), human_approved: z.boolean().optional().default(false) }).strict();
const stateBody = z.object({ state: z.enum(["enabled", "disabled"]) }).strict();
const migrateBody = z.object({ plugin_version: z.string().min(1).max(128), manifest_hash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown().optional() }).strict();
const targetConfigJsonBody = z.object({ yaml: z.string().min(1).max(65_536) }).strict();
export const pluginTargetConfigRequestBody = z.union([targetConfigJsonBody, z.string().min(1).max(65_536)]);
const debuggerSessionBody = z.object({
  device_id: z.string().uuid(),
  case_id: z.string().uuid(),
  target_config_id: z.string().uuid().nullable().optional(),
  target_config_revision: z.number().int().positive().nullable().optional(),
  target_id: z.string().min(1).max(64).nullable().optional(),
  artifact_id: z.string().uuid().nullable().optional(),
  device_firmware_version: z.string().max(256).nullable().optional(),
  lease_ms: z.number().int().min(1_000).max(900_000).optional(),
  ttl_ms: z.number().int().min(2_000).max(7 * 24 * 60 * 60_000).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).optional(),
}).strict().refine((value) => {
  const hasId = value.target_config_id !== null && value.target_config_id !== undefined;
  const hasRevision = value.target_config_revision !== null && value.target_config_revision !== undefined;
  const hasTarget = value.target_id !== null && value.target_id !== undefined;
  return hasId === hasRevision && hasRevision === hasTarget;
}, "target configuration id, revision and target id must be provided together");
const debuggerArtifactQuery = z.object({ kind: z.enum(["elf", "firmware"]), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), case_id: z.string().uuid().optional(), content_type: z.string().min(1).max(128).refine((value) => !/[\r\n]/.test(value)).default("application/octet-stream") }).strict();

function parseInstallationId(value: string): string | null {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function invalidInstallationId(set: { status?: number | string }): { error: "invalid_request"; message: string } {
  set.status = 400;
  return { error: "invalid_request", message: "installation ID must be a UUID" };
}

// --- Shared route helpers ---------------------------------------------------
//
// Every plugin route repeats the same sequence: authenticate, validate IDs and
// body, resolve an accessible installation, then forward to the Manager while
// mapping any transport failure to one shared 503 shape. The helpers below
// return failures as data so handlers keep controlling `set` and the returned
// payload explicitly; the wire behavior (status codes, messages, ordering)
// must stay identical to the pre-helper implementations.

interface SetStatus {
  status?: number | string;
}

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401; payload: { error: "unauthorized"; message: string } };

/** Authenticate the caller or produce the shared 401 failure. */
async function requireUser(prisma: PrismaClient, jwt: JwtConfig, request: Request): Promise<AuthResult> {
  const user = await authenticateRequest(prisma, jwt, request);
  if (!user) return { ok: false, status: 401, payload: { error: "unauthorized", message: "authentication required" } };
  return { ok: true, userId: user.user.id };
}

type InstallationLookup =
  | { ok: true; projectId: string }
  | { ok: false; status: 404 | 403; payload: { error: string; message: string } };

/**
 * Resolve one installation the caller may access: 404 when it does not exist,
 * 403 when the user has lost project membership.
 */
async function loadInstallationForUser(prisma: PrismaClient, installationId: string, userId: string): Promise<InstallationLookup> {
  const installation = await prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { projectId: true } });
  if (!installation) return { ok: false, status: 404, payload: { error: "not_found", message: "installation not found" } };
  if (!(await userCanAccessProject(prisma, userId, installation.projectId))) {
    return { ok: false, status: 403, payload: { error: "forbidden", message: "project access required" } };
  }
  return { ok: true, projectId: installation.projectId };
}

function pluginManagerNotConfigured(set: SetStatus): { error: "plugin_manager_unavailable"; message: string } {
  set.status = 503;
  return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" };
}

function pluginManagerUnavailable(set: SetStatus): { error: "plugin_manager_unavailable"; message: string } {
  set.status = 503;
  return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" };
}

/** Forward one JSON POST to the Manager, mapping every failure to the shared 503 shape. */
async function callManagerJson(options: PluginManagerOptions | undefined, path: string, body: unknown, set: SetStatus): Promise<unknown> {
  if (!options) return pluginManagerNotConfigured(set);
  try {
    const result = await callManager(options, path, body);
    set.status = result.status;
    return result.value;
  } catch {
    return pluginManagerUnavailable(set);
  }
}

/** Streamed-upload counterpart of {@link callManagerJson}; header forwarding stays with the caller. */
async function callManagerUpload(options: PluginManagerOptions | undefined, path: string, request: Request, headers: Record<string, string>, set: SetStatus): Promise<unknown> {
  if (!options) return pluginManagerNotConfigured(set);
  try {
    const result = await callManagerBinary(options, path, request, headers);
    set.status = result.status;
    return result.value;
  } catch {
    return pluginManagerUnavailable(set);
  }
}

/** Human API is the only browser-facing authority for plugin metadata. */
export function createPluginManagerRoutes(prisma: PrismaClient, jwt: JwtConfig, options?: PluginManagerOptions) {
  return new Elysia().get("/v1/plugins/catalog", async ({ request, set }) => {
    const auth = await requireUser(prisma, jwt, request);
    if (!auth.ok) { set.status = auth.status; return auth.payload; }
    if (!options) return pluginManagerNotConfigured(set);
    try { return await fetchCatalog(options); }
    catch { return pluginManagerUnavailable(set); }
  })
    .post("/v1/plugin-installations", async ({ request, body, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const parsed = installationBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      if (!(await userCanAccessProject(prisma, auth.userId, parsed.data.project_id))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      return await callManagerJson(options, "/internal/plugins/installations", {
        projectId: parsed.data.project_id, pluginId: parsed.data.plugin_id, pluginVersion: parsed.data.plugin_version,
        manifestHash: parsed.data.manifest_hash, config: parsed.data.config ?? null,
      }, set);
    })
    .post("/v1/plugin-installations/:id/bindings", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = bindingBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { projectId: true } });
      const device = await prisma.device.findUnique({ where: { id: parsed.data.device_id }, select: { projectId: true } });
      if (!installation || !device) { set.status = 404; return { error: "not_found", message: "installation or device not found" }; }
      if (installation.projectId !== device.projectId || !(await userCanAccessProject(prisma, auth.userId, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      return await callManagerJson(options, `/internal/plugins/installations/${installationId}/bindings`, {
        deviceId: parsed.data.device_id,
        profileId: parsed.data.profile_id,
        profileVersion: parsed.data.profile_version,
      }, set);
    })
    .post("/v1/plugin-installations/:id/actions/:actionId", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = pluginActionRequestBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { projectId: true } });
      const device = await prisma.device.findUnique({ where: { id: parsed.data.device_id }, select: { projectId: true } });
      if (!installation || !device) { set.status = 404; return { error: "not_found", message: "installation or device not found" }; }
      if (installation.projectId !== device.projectId || !(await userCanAccessProject(prisma, auth.userId, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      return await callManagerJson(options, "/internal/plugins/actions/encode", {
        installationId, userId: auth.userId, deviceId: parsed.data.device_id, actionId: params.actionId, input: parsed.data.input,
        humanApproved: parsed.data.human_approved,
        timeoutMs: pluginManagerOperationTimeoutMs(options?.requestTimeoutMs),
      }, set);
    })
    .post("/v1/plugin-installations/:id/debugger/target-config", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = pluginTargetConfigRequestBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const yaml = typeof parsed.data === "string" ? parsed.data : parsed.data.yaml;
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/target-config", {
        installationId,
        projectId: installation.projectId,
        userId: auth.userId,
        yaml,
        timeoutMs: pluginManagerOperationTimeoutMs(options?.requestTimeoutMs),
      }, set);
    })
    .get("/v1/plugin-installations/:id/debugger/target-configs", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/target-configs", {
        installationId,
        projectId: installation.projectId,
        userId: auth.userId,
        timeoutMs: pluginManagerOperationTimeoutMs(options?.requestTimeoutMs),
      }, set);
    })
    .get("/v1/plugin-installations/:id/debugger/artifacts", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/artifacts", {
        installationId,
        projectId: installation.projectId,
        userId: auth.userId,
        timeoutMs: pluginManagerOperationTimeoutMs(options?.requestTimeoutMs),
      }, set);
    })
    .post("/v1/plugin-installations/:id/debugger/sessions", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = debuggerSessionBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { projectId: true } });
      const device = await prisma.device.findUnique({ where: { id: parsed.data.device_id }, select: { projectId: true } });
      if (!installation || !device) { set.status = 404; return { error: "not_found", message: "installation or device not found" }; }
      if (installation.projectId !== device.projectId || !(await userCanAccessProject(prisma, auth.userId, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      return await callManagerJson(options, "/internal/plugins/debugger/sessions", {
        installationId,
        projectId: installation.projectId,
        deviceId: parsed.data.device_id,
        userId: auth.userId,
        caseId: parsed.data.case_id,
        ...(parsed.data.target_config_id !== undefined ? { targetConfigId: parsed.data.target_config_id } : {}),
        ...(parsed.data.target_config_revision !== undefined ? { targetConfigRevision: parsed.data.target_config_revision } : {}),
        ...(parsed.data.target_id !== undefined ? { targetId: parsed.data.target_id } : {}),
        ...(parsed.data.artifact_id !== undefined ? { artifactId: parsed.data.artifact_id } : {}),
        ...(parsed.data.device_firmware_version !== undefined ? { deviceFirmwareVersion: parsed.data.device_firmware_version } : {}),
        ...(parsed.data.lease_ms !== undefined ? { leaseMs: parsed.data.lease_ms } : {}),
        ...(parsed.data.ttl_ms !== undefined ? { ttlMs: parsed.data.ttl_ms } : {}),
        ...(parsed.data.timeout_ms !== undefined ? { timeoutMs: parsed.data.timeout_ms } : {}),
      }, set);
    })
    .get("/v1/plugin-installations/:id/debugger/executions/:executionId", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = z.string().uuid().safeParse(params.id);
      const executionId = z.string().uuid().safeParse(params.executionId);
      if (!installationId.success || !executionId.success) { set.status = 400; return { error: "invalid_request", message: "installation and execution IDs must be UUIDs" }; }
      const installation = await loadInstallationForUser(prisma, installationId.data, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/executions/get", {
        executionId: executionId.data,
        installationId: installationId.data,
        projectId: installation.projectId,
        userId: auth.userId,
      }, set);
    })
    .post("/v1/plugin-installations/:id/debugger/executions/:executionId/pause", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = z.string().uuid().safeParse(params.id);
      const executionId = z.string().uuid().safeParse(params.executionId);
      if (!installationId.success || !executionId.success) { set.status = 400; return { error: "invalid_request", message: "installation and execution IDs must be UUIDs" }; }
      const installation = await loadInstallationForUser(prisma, installationId.data, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/executions/pause", {
        executionId: executionId.data,
        installationId: installationId.data,
        projectId: installation.projectId,
        userId: auth.userId,
      }, set);
    })
    .post("/v1/plugin-installations/:id/debugger/executions/:executionId/commands/:commandId/cancel", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = z.string().uuid().safeParse(params.id);
      const executionId = z.string().uuid().safeParse(params.executionId);
      const commandId = z.string().uuid().safeParse(params.commandId);
      if (!installationId.success || !executionId.success || !commandId.success) { set.status = 400; return { error: "invalid_request", message: "installation, execution and command IDs must be UUIDs" }; }
      const installation = await loadInstallationForUser(prisma, installationId.data, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, "/internal/plugins/debugger/executions/commands/cancel", {
        executionId: executionId.data,
        commandId: commandId.data,
        installationId: installationId.data,
        projectId: installation.projectId,
        userId: auth.userId,
      }, set);
    })
    .post("/v1/plugin-installations/:id/debugger/artifacts", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const url = new URL(request.url);
      const parsed = debuggerArtifactQuery.safeParse({ kind: url.searchParams.get("kind"), filename: url.searchParams.get("filename"), case_id: url.searchParams.get("case_id") ?? undefined, content_type: url.searchParams.get("content_type") ?? undefined });
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const uploadId = z.string().uuid().safeParse(request.headers.get("idempotency-key") ?? "");
      if (!uploadId.success) { set.status = 400; return { error: "invalid_request", message: "Idempotency-Key must be a UUID" }; }
      const totalSize = Number(request.headers.get("content-length") ?? "0");
      if (!Number.isSafeInteger(totalSize) || totalSize < 1 || totalSize > 64 * 1024 * 1024) { set.status = totalSize > 64 * 1024 * 1024 ? 413 : 411; return { error: totalSize > 64 * 1024 * 1024 ? "payload_too_large" : "length_required", message: "artifact content-length must be between 1 and 67108864 bytes" }; }
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerUpload(options, `/internal/plugins/debugger/installations/${installationId}/artifacts`, request, {
        "x-soulcloud-project-id": installation.projectId,
        "x-soulcloud-user-id": auth.userId,
        ...(parsed.data.case_id ? { "x-soulcloud-case-id": parsed.data.case_id } : {}),
        "x-soulcloud-upload-id": uploadId.data,
        "x-soulcloud-artifact-kind": parsed.data.kind,
        "x-soulcloud-artifact-filename": parsed.data.filename,
        "x-soulcloud-artifact-content-type": parsed.data.content_type,
      }, set);
    })
    .post("/v1/plugin-installations/:id/state", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = stateBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, `/internal/plugins/installations/${installationId}/state`, parsed.data, set);
    })
    .post("/v1/plugin-installations/:id/migrate", async ({ request, body, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const parsed = migrateBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, `/internal/plugins/installations/${installationId}/migrate`, {
        pluginVersion: parsed.data.plugin_version,
        manifestHash: parsed.data.manifest_hash,
        config: parsed.data.config ?? null,
      }, set);
    })
    .post("/v1/plugin-installations/:id/reconcile", async ({ request, params, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      const installation = await loadInstallationForUser(prisma, installationId, auth.userId);
      if (!installation.ok) { set.status = installation.status; return installation.payload; }
      return await callManagerJson(options, `/internal/plugins/installations/${installationId}/reconcile`, {}, set);
    })
    .get("/v1/plugin-installations/:id/ui-session/:routeId", async ({ request, params, query, set }) => {
      const auth = await requireUser(prisma, jwt, request);
      if (!auth.ok) { set.status = auth.status; return auth.payload; }
      const installationId = parseInstallationId(params.id);
      if (!installationId) return invalidInstallationId(set);
      if (!options?.uiSessionSecret) { set.status = 503; return { error: "plugin_ui_unavailable", message: "plugin UI sessions are not configured" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (installation.state !== "enabled" || !(await userCanAccessProject(prisma, auth.userId, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "plugin installation access denied" }; }
      const snapshot = await prisma.pluginManifestSnapshot.findUnique({ where: { pluginId_pluginVersion: { pluginId: installation.pluginId, pluginVersion: installation.pluginVersion } }, select: { canonicalManifest: true, manifestHash: true } });
      const manifest = snapshot?.canonicalManifest as { ui?: { routes?: Array<{ id: string; path: string }> } } | undefined;
      const route = manifest?.ui?.routes?.find((item) => item.id === params.routeId);
      if (!snapshot || snapshot.manifestHash.trim() !== installation.manifestHash.trim() || !route) { set.status = 404; return { error: "not_found", message: "plugin UI route not found" }; }
      const locale = typeof query?.locale === "string" && query.locale.length <= 32 ? query.locale : "en";
      // The permission snapshot is a read-only claim for the plugin's own UI
      // rendering; platform authorization stays here and in the Manager. The
      // platform has no role model yet (user_projects is membership-only), so
      // sessions carry the generic base permission granted to every verified
      // project member instead of an empty snapshot. Product-specific
      // permissions (debug.case.view etc.) replace or extend this list once a
      // role/permission source exists.
      const ttlSeconds = options.uiSessionTtlSeconds ?? 300;
      const session = signPluginUiSession({ secret: options.uiSessionSecret, ttlSeconds }, { sub: auth.userId, projectId: installation.projectId, installationId, pluginId: installation.pluginId, pluginVersion: installation.pluginVersion, manifestHash: installation.manifestHash.trim(), routeId: params.routeId, permissions: ["plugin_ui.render"], locale });
      const uiOrigin = options.uiOrigin?.replace(/\/$/, "");
      if (!uiOrigin) { set.status = 503; return { error: "plugin_ui_unavailable", message: "plugin UI origin is not configured" }; }
      return { bootstrap_url: `${uiOrigin}/bootstrap`, bootstrap_token: session, path: `/plugins/${installationId}${route.path}`, expires_in: ttlSeconds };
    });
}
