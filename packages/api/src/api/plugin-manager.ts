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
const actionBody = z.object({ device_id: z.string().uuid(), input: z.unknown() }).strict();
const stateBody = z.object({ state: z.enum(["enabled", "disabled"]) }).strict();
const migrateBody = z.object({ plugin_version: z.string().min(1).max(128), manifest_hash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown().optional() }).strict();
const targetConfigBody = z.object({ yaml: z.string().min(1).max(65_536) }).strict();
const debuggerArtifactQuery = z.object({ kind: z.enum(["elf", "firmware"]), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), case_id: z.string().uuid().optional(), content_type: z.string().min(1).max(128).refine((value) => !/[\r\n]/.test(value)).default("application/octet-stream") }).strict();

/** Human API is the only browser-facing authority for plugin metadata. */
export function createPluginManagerRoutes(prisma: PrismaClient, jwt: JwtConfig, options?: PluginManagerOptions) {
  return new Elysia().get("/v1/plugins/catalog", async ({ request, set }) => {
    const user = await authenticateRequest(prisma, jwt, request);
    if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
    if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
    try { return await fetchCatalog(options); }
    catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
  })
    .post("/v1/plugin-installations", async ({ request, body, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = installationBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      if (!(await userCanAccessProject(prisma, user.user.id, parsed.data.project_id))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, "/internal/plugins/installations", {
          projectId: parsed.data.project_id, pluginId: parsed.data.plugin_id, pluginVersion: parsed.data.plugin_version,
          manifestHash: parsed.data.manifest_hash, config: parsed.data.config ?? null,
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/bindings", async ({ request, body, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = bindingBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      const device = await prisma.device.findUnique({ where: { id: parsed.data.device_id }, select: { projectId: true } });
      if (!installation || !device) { set.status = 404; return { error: "not_found", message: "installation or device not found" }; }
      if (installation.projectId !== device.projectId || !(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, `/internal/plugins/installations/${params.id}/bindings`, {
          deviceId: parsed.data.device_id,
          profileId: parsed.data.profile_id,
          profileVersion: parsed.data.profile_version,
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/actions/:actionId", async ({ request, body, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = actionBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      const device = await prisma.device.findUnique({ where: { id: parsed.data.device_id }, select: { projectId: true } });
      if (!installation || !device) { set.status = 404; return { error: "not_found", message: "installation or device not found" }; }
      if (installation.projectId !== device.projectId || !(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, "/internal/plugins/actions/encode", {
          installationId: params.id, userId: user.user.id, deviceId: parsed.data.device_id, actionId: params.actionId, input: parsed.data.input,
          humanApproved: true,
          timeoutMs: pluginManagerOperationTimeoutMs(options.requestTimeoutMs),
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/debugger/target-config", async ({ request, body, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = targetConfigBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, "/internal/plugins/debugger/target-config", {
          installationId: params.id,
          projectId: installation.projectId,
          userId: user.user.id,
          yaml: parsed.data.yaml,
          timeoutMs: pluginManagerOperationTimeoutMs(options.requestTimeoutMs),
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .get("/v1/plugin-installations/:id/debugger/target-configs", async ({ request, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, "/internal/plugins/debugger/target-configs", {
          installationId: params.id,
          projectId: installation.projectId,
          userId: user.user.id,
          timeoutMs: pluginManagerOperationTimeoutMs(options.requestTimeoutMs),
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .get("/v1/plugin-installations/:id/debugger/artifacts", async ({ request, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, "/internal/plugins/debugger/artifacts", {
          installationId: params.id,
          projectId: installation.projectId,
          userId: user.user.id,
          timeoutMs: pluginManagerOperationTimeoutMs(options.requestTimeoutMs),
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/debugger/artifacts", async ({ request, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const url = new URL(request.url);
      const parsed = debuggerArtifactQuery.safeParse({ kind: url.searchParams.get("kind"), filename: url.searchParams.get("filename"), content_type: url.searchParams.get("content_type") ?? undefined });
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const totalSize = Number(request.headers.get("content-length") ?? "0");
      if (!Number.isSafeInteger(totalSize) || totalSize < 1 || totalSize > 64 * 1024 * 1024) { set.status = totalSize > 64 * 1024 * 1024 ? 413 : 411; return { error: totalSize > 64 * 1024 * 1024 ? "payload_too_large" : "length_required", message: "artifact content-length must be between 1 and 67108864 bytes" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManagerBinary(options, `/internal/plugins/debugger/installations/${params.id}/artifacts`, request, {
          "x-soulcloud-project-id": installation.projectId,
          "x-soulcloud-user-id": user.user.id,
          ...(parsed.data.case_id ? { "x-soulcloud-case-id": parsed.data.case_id } : {}),
          "x-soulcloud-artifact-kind": parsed.data.kind,
          "x-soulcloud-artifact-filename": parsed.data.filename,
          "x-soulcloud-artifact-content-type": parsed.data.content_type,
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/state", async ({ request, body, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = stateBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, `/internal/plugins/installations/${params.id}/state`, parsed.data);
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/migrate", async ({ request, body, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const parsed = migrateBody.safeParse(body);
      if (!parsed.success) { set.status = 400; return { error: "invalid_request", message: parsed.error.message }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, `/internal/plugins/installations/${params.id}/migrate`, {
          pluginVersion: parsed.data.plugin_version,
          manifestHash: parsed.data.manifest_hash,
          config: parsed.data.config ?? null,
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .post("/v1/plugin-installations/:id/reconcile", async ({ request, params, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (!(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "project access required" }; }
      if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
      try {
        const result = await callManager(options, `/internal/plugins/installations/${params.id}/reconcile`, {});
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    })
    .get("/v1/plugin-installations/:id/ui-session/:routeId", async ({ request, params, query, set }) => {
      const user = await authenticateRequest(prisma, jwt, request);
      if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
      if (!options?.uiSessionSecret) { set.status = 503; return { error: "plugin_ui_unavailable", message: "plugin UI sessions are not configured" }; }
      const installation = await prisma.pluginInstallation.findUnique({ where: { id: params.id }, select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true } });
      if (!installation) { set.status = 404; return { error: "not_found", message: "installation not found" }; }
      if (installation.state !== "enabled" || !(await userCanAccessProject(prisma, user.user.id, installation.projectId))) { set.status = 403; return { error: "forbidden", message: "plugin installation access denied" }; }
      const snapshot = await prisma.pluginManifestSnapshot.findUnique({ where: { pluginId_pluginVersion: { pluginId: installation.pluginId, pluginVersion: installation.pluginVersion } }, select: { canonicalManifest: true, manifestHash: true } });
      const manifest = snapshot?.canonicalManifest as { ui?: { routes?: Array<{ id: string; path: string }> } } | undefined;
      const route = manifest?.ui?.routes?.find((item) => item.id === params.routeId);
      if (!snapshot || snapshot.manifestHash.trim() !== installation.manifestHash.trim() || !route) { set.status = 404; return { error: "not_found", message: "plugin UI route not found" }; }
      const locale = typeof query?.locale === "string" && query.locale.length <= 32 ? query.locale : "en";
      const ttlSeconds = options.uiSessionTtlSeconds ?? 300;
      const session = signPluginUiSession({ secret: options.uiSessionSecret, ttlSeconds }, { sub: user.user.id, projectId: installation.projectId, installationId: params.id, pluginId: installation.pluginId, pluginVersion: installation.pluginVersion, manifestHash: installation.manifestHash.trim(), routeId: params.routeId, permissions: [], locale });
      const uiOrigin = options.uiOrigin?.replace(/\/$/, "");
      if (!uiOrigin) { set.status = 503; return { error: "plugin_ui_unavailable", message: "plugin UI origin is not configured" }; }
      return { bootstrap_url: `${uiOrigin}/bootstrap`, bootstrap_token: session, path: `/plugins/${params.id}${route.path}`, expires_in: ttlSeconds };
    });
}
