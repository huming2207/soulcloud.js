import { PluginManager } from "./manager";
import { verifyPluginUiSession } from "@soulcloud/core";

export interface PluginManagerServerOptions { hostname: string; port: number; serviceToken: string; manager: PluginManager; uiSessionSecret?: string; uiSessionTtlSeconds?: number; }
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

function renderDocument(html: string, title?: string): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title ?? "Soulcloud")}</title></head><body>${html}</body></html>`;
  return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function startPluginManagerServer(options: PluginManagerServerOptions): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health/live") return json(200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/health/ready") return json(200, { status: "ready" });
      if (url.pathname.startsWith("/plugins/")) {
        if (!options.uiSessionSecret) return json(503, { error: "plugin_ui_unavailable" });
        const token = request.headers.get("x-soulcloud-plugin-session");
        if (!token) return json(401, { error: "plugin_ui_session_required" });
        let session;
        try {
          session = verifyPluginUiSession({ secret: options.uiSessionSecret, ttlSeconds: options.uiSessionTtlSeconds ?? 300 }, token);
        } catch { return json(401, { error: "invalid_plugin_ui_session" }); }
        if (!url.pathname.startsWith(`/plugins/${session.installationId}/`)) return json(403, { error: "plugin_ui_scope_mismatch" });
        const manifest = options.manager.getManifest(session.pluginId, session.pluginVersion);
        const route = manifest?.ui?.routes.find((item) => item.id === session.routeId);
        const routePath = route?.path.startsWith("/") ? route.path : `/${route?.path ?? ""}`;
        if (!route || url.pathname !== `/plugins/${session.installationId}${routePath}`) return json(404, { error: "plugin_ui_route_not_found" });
        const params = Object.fromEntries(url.searchParams.entries());
        try {
          if (request.method === "GET") {
            const output = await options.manager.renderPluginUi(session, crypto.randomUUID(), params) as { html?: unknown; title?: string; status?: number };
            if (typeof output.html !== "string") return json(502, { error: "plugin_ui_invalid_output" });
            const response = renderDocument(output.html, output.title);
            if (output.status && output.status !== 200) return new Response(response.body, { status: output.status, headers: response.headers });
            return response;
          }
          if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
          const body = await requestJson(request) as { action?: unknown };
          const actionResult = await options.manager.handlePluginUiAction(session, crypto.randomUUID(), params, body.action);
          if (actionResult && typeof actionResult === "object" && "redirect" in actionResult && typeof (actionResult as { redirect?: unknown }).redirect === "string") {
            const redirect = (actionResult as { redirect: string }).redirect;
            if (!redirect.startsWith("/") || redirect.startsWith("//")) return json(502, { error: "plugin_ui_invalid_redirect" });
            return new Response(null, { status: 303, headers: { location: redirect } });
          }
          const output = await options.manager.renderPluginUi(session, crypto.randomUUID(), params) as { html?: unknown; title?: string };
          if (typeof output.html !== "string") return json(502, { error: "plugin_ui_invalid_output" });
          return renderDocument(output.html, output.title);
        } catch (error) { return failure(error); }
      }
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
