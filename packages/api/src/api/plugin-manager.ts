import type { JwtConfig, PrismaClient } from "@soulcloud/core";
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

const installationBody = z.object({ project_id: z.string().uuid(), plugin_id: z.string().min(1).max(128), plugin_version: z.string().min(1).max(128), manifest_hash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown().optional() }).strict();
const bindingBody = z.object({ device_id: z.string().uuid(), profile_id: z.string().min(1).max(128), profile_version: z.number().int().positive() }).strict();
const actionBody = z.object({ device_id: z.string().uuid(), input: z.unknown() }).strict();

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
        const result = await callManager(options, `/internal/plugins/installations/${params.id}/bindings`, parsed.data);
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
          installationId: params.id, deviceId: parsed.data.device_id, actionId: params.actionId, input: parsed.data.input,
        });
        set.status = result.status;
        return result.value;
      } catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
    });
}
