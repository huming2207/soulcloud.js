import type { JwtConfig, PrismaClient } from "@soulcloud/core";
import { Elysia } from "elysia";
import type { PluginManagerOptions } from "./app";
import { authenticateRequest } from "./validate";

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

/** Human API is the only browser-facing authority for plugin metadata. */
export function createPluginManagerRoutes(prisma: PrismaClient, jwt: JwtConfig, options?: PluginManagerOptions) {
  return new Elysia().get("/v1/plugins/catalog", async ({ request, set }) => {
    const user = await authenticateRequest(prisma, jwt, request);
    if (!user) { set.status = 401; return { error: "unauthorized", message: "authentication required" }; }
    if (!options) { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is not configured" }; }
    try { return await fetchCatalog(options); }
    catch { set.status = 503; return { error: "plugin_manager_unavailable", message: "plugin manager is unavailable" }; }
  });
}
