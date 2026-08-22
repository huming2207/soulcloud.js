import { PluginManager } from "./manager";

export interface PluginManagerServerOptions { hostname: string; port: number; serviceToken: string; manager: PluginManager; }
function json(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function authorized(request: Request, token: string): boolean { return request.headers.get("authorization") === `Bearer ${token}`; }

async function requestJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 1_048_576) throw Object.assign(new Error("request body too large"), { status: 413 });
  try { return JSON.parse(body); } catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

function failure(error: unknown): Response {
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const message = error instanceof Error ? error.message : "plugin manager operation failed";
  const mapped = message.startsWith("invalid action input") ? 400 : message.includes("plugin encoder") ? 502 : status;
  return json(mapped, { error: mapped === 400 ? "invalid_request" : mapped === 502 ? "plugin_action_failed" : "plugin_manager_error", message });
}

export function startPluginManagerServer(options: PluginManagerServerOptions): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health/live") return json(200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/health/ready") return json(200, { status: "ready" });
      if (!url.pathname.startsWith("/internal/plugins/")) return json(404, { error: "not_found" });
      if (!authorized(request, options.serviceToken)) return json(401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/plugins/catalog") return json(200, { plugins: options.manager.listCatalog() });
      if (request.method !== "POST") return json(404, { error: "not_found" });
      try {
        const body = await requestJson(request) as Record<string, unknown>;
        if (url.pathname === "/internal/plugins/installations") {
          const installation = await options.manager.createInstallation({
            projectId: String(body.projectId), pluginId: String(body.pluginId), pluginVersion: String(body.pluginVersion),
            manifestHash: String(body.manifestHash), config: body.config ?? null,
          });
          return json(201, installation);
        }
        const binding = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/bindings$/);
        if (binding) {
          await options.manager.bindDevice({ installationId: binding[1]!, deviceId: String(body.deviceId), profileId: String(body.profileId), profileVersion: Number(body.profileVersion) });
          return new Response(null, { status: 204 });
        }
        const state = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/state$/);
        if (state) {
          await options.manager.setInstallationState(state[1]!, body.state === "disabled" ? "disabled" : "enabled");
          return new Response(null, { status: 204 });
        }
        const reconcile = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/reconcile$/);
        if (reconcile) {
          await options.manager.reconcileInstallation(reconcile[1]!);
          return new Response(null, { status: 204 });
        }
        const migrate = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/migrate$/);
        if (migrate) {
          await options.manager.migrateInstallation(migrate[1]!, String(body.pluginVersion), String(body.manifestHash), body.config ?? null);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/internal/plugins/actions/encode") {
          return json(200, await options.manager.encodeAction({
            installationId: String(body.installationId), deviceId: String(body.deviceId), actionId: String(body.actionId), actionInput: body.input ?? null,
          }));
        }
      } catch (error) { return failure(error); }
      return json(404, { error: "not_found" });
    },
  });
  return { url: server.url.toString(), stop: () => server.stop(true) };
}
