import { PluginManager } from "./manager";
import { pluginUiSessionCookieName, verifyPluginUiSession } from "@soulcloud/core";
import { coerceStringActionInput, validateActionInput, type ActionInputSchema, type PluginUiRoute } from "@soulcloud/plugin-sdk";
import { z, type ZodType } from "zod";

export interface PluginManagerServerOptions { hostname: string; port: number; serviceToken: string; manager: PluginManager; uiSessionSecret?: string; uiSessionTtlSeconds?: number; }
function json(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function authorized(request: Request, token: string): boolean { return request.headers.get("authorization") === `Bearer ${token}`; }

function cookie(request: Request, name: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const split = part.indexOf("=");
    if (split > 0 && part.slice(0, split).trim() === name) return part.slice(split + 1).trim();
  }
  return undefined;
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function validateUiInput(schema: ActionInputSchema, value: unknown): void {
  const result = validateActionInput(schema, value);
  if (!result.ok) throw invalidRequest(result.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; "));
}

function parseUiQuery(url: URL, route: PluginUiRoute): Record<string, string | number | boolean> {
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) throw invalidRequest(`duplicate query parameter: ${key}`);
    raw[key] = value;
  }
  if (!route.querySchema) {
    if (Object.keys(raw).length > 0) throw invalidRequest("this plugin UI route does not accept query parameters");
    return {};
  }
  const parsed = coerceStringActionInput(route.querySchema, raw);
  validateUiInput(route.querySchema, parsed);
  return parsed as Record<string, string | number | boolean>;
}

async function parseUiAction(request: Request, schema: ActionInputSchema): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const body = await requestJson(request);
    const action = body && typeof body === "object" && !Array.isArray(body) && "action" in body
      ? (body as { action: unknown }).action
      : body;
    validateUiInput(schema, action);
    return action;
  }
  if (contentType !== "application/x-www-form-urlencoded" && contentType !== "multipart/form-data") {
    throw invalidRequest("plugin UI action must use JSON or form data");
  }
  const raw: Record<string, string> = {};
  for (const [key, value] of await request.formData()) {
    if (typeof value !== "string") throw invalidRequest("file fields are not declared by this plugin UI action");
    if (Object.prototype.hasOwnProperty.call(raw, key)) throw invalidRequest(`duplicate form field: ${key}`);
    raw[key] = value;
  }
  const action = coerceStringActionInput(schema, raw);
  validateUiInput(schema, action);
  return action;
}

async function requestJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 1_048_576) throw Object.assign(new Error("request body too large"), { status: 413 });
  try { return JSON.parse(body); } catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

function failure(error: unknown): Response {
  const explicitStatus = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : undefined;
  const explicitCode = typeof error === "object" && error !== null && "publicCode" in error
    ? String((error as { publicCode: unknown }).publicCode)
    : undefined;
  const message = error instanceof Error ? error.message : "plugin manager operation failed";
  const mapped = Number.isInteger(explicitStatus) && explicitStatus! >= 400 && explicitStatus! <= 599
    ? explicitStatus!
    : message.startsWith("invalid action input") ? 400
      : message.includes("plugin encoder") ? 502
        : message.includes("not found") ? 404
          : message.includes("disabled") || message.includes("changed concurrently") || message.includes("changed while") ? 409
            : 500;
  const publicMessage = mapped >= 500 && mapped !== 502 ? "plugin manager operation failed" : message;
  const code = explicitCode && ["invalid_action_input", "invalid_action_output", "action_not_found", "plugin_ui_invalid_output", "plugin_manager_overloaded"].includes(explicitCode)
    ? explicitCode
    : mapped === 400 ? "invalid_request" : mapped === 404 ? "not_found" : mapped === 409 ? "conflict" : mapped === 502 ? "plugin_output_invalid" : mapped === 503 ? "plugin_unavailable" : "plugin_manager_error";
  return json(mapped, { error: code, message: publicMessage });
}

const createInstallationSchema = z.object({ projectId: z.string().uuid(), pluginId: z.string().min(1).max(128), pluginVersion: z.string().min(1).max(128), manifestHash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown() }).strict();
const bindingSchema = z.object({ deviceId: z.string().uuid(), profileId: z.string().min(1).max(128), profileVersion: z.number().int().positive() }).strict();
const stateSchema = z.object({ state: z.enum(["enabled", "disabled"]) }).strict();
const migrateSchema = z.object({ pluginVersion: z.string().min(1).max(128), manifestHash: z.string().regex(/^[0-9a-f]{64}$/), config: z.unknown() }).strict();
const encodeActionSchema = z.object({ installationId: z.string().uuid(), deviceId: z.string().uuid(), actionId: z.string().min(1).max(128), input: z.unknown() }).strict();

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidRequest(result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  return result.data;
}

function parseInstallationId(value: string): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) throw invalidRequest("installation ID must be a UUID");
  return result.data;
}

function renderDocument(html: string, title?: string, status = 200): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title ?? "Soulcloud")}</title></head><body>${html}</body></html>`;
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function startPluginManagerServer(options: PluginManagerServerOptions): { url: string; stop(): Promise<void> } {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: 1_048_576,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health/live") return json(200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/health/ready") {
        return await options.manager.ready() ? json(200, { status: "ready" }) : json(503, { status: "not_ready" });
      }
      if (url.pathname.startsWith("/plugins/")) {
        if (!options.uiSessionSecret) return json(503, { error: "plugin_ui_unavailable" });
        const installationId = url.pathname.split("/")[2] ?? "";
        const token = cookie(request, pluginUiSessionCookieName(installationId));
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
        const allowedMethods = route.methods ?? ["GET"];
        if (!allowedMethods.includes(request.method as "GET" | "POST")) return json(405, { error: "method_not_allowed" });
        try {
          const params = parseUiQuery(url, route);
          if (request.method === "GET") {
            const output = await options.manager.renderPluginUi(session, crypto.randomUUID(), params) as { html?: unknown; title?: string; status?: number };
            if (typeof output.html !== "string") return json(502, { error: "plugin_ui_invalid_output" });
            return renderDocument(output.html, output.title, output.status);
          }
          if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
          const actionResult = await options.manager.handlePluginUiAction(session, crypto.randomUUID(), params, await parseUiAction(request, route.actionSchema!));
          if (actionResult && typeof actionResult === "object" && "redirect" in actionResult && typeof (actionResult as { redirect?: unknown }).redirect === "string") {
            const redirect = (actionResult as { redirect: string }).redirect;
            if (!redirect.startsWith(`/plugins/${session.installationId}/`)) return json(502, { error: "plugin_ui_invalid_redirect" });
            return new Response(null, { status: 303, headers: { location: redirect } });
          }
          const output = await options.manager.renderPluginUi(session, crypto.randomUUID(), params) as { html?: unknown; title?: string; status?: number };
          if (typeof output.html !== "string") return json(502, { error: "plugin_ui_invalid_output" });
          return renderDocument(output.html, output.title, output.status);
        } catch (error) { return failure(error); }
      }
      if (!url.pathname.startsWith("/internal/plugins/")) return json(404, { error: "not_found" });
      if (!authorized(request, options.serviceToken)) return json(401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/plugins/catalog") return json(200, { plugins: options.manager.listCatalog() });
      if (request.method !== "POST") return json(404, { error: "not_found" });
      try {
        const body = await requestJson(request) as Record<string, unknown>;
        if (url.pathname === "/internal/plugins/installations") {
          const input = parseBody(createInstallationSchema, body);
          const installation = await options.manager.createInstallation(input);
          return json(201, installation);
        }
        const binding = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/bindings$/);
        if (binding) {
          const input = parseBody(bindingSchema, body);
          await options.manager.bindDevice({ installationId: parseInstallationId(binding[1]!), ...input });
          return new Response(null, { status: 204 });
        }
        const state = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/state$/);
        if (state) {
          const input = parseBody(stateSchema, body);
          await options.manager.setInstallationState(parseInstallationId(state[1]!), input.state);
          return new Response(null, { status: 204 });
        }
        const reconcile = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/reconcile$/);
        if (reconcile) {
          await options.manager.reconcileInstallation(parseInstallationId(reconcile[1]!));
          return new Response(null, { status: 204 });
        }
        const migrate = url.pathname.match(/^\/internal\/plugins\/installations\/([^/]+)\/migrate$/);
        if (migrate) {
          const input = parseBody(migrateSchema, body);
          await options.manager.migrateInstallation(parseInstallationId(migrate[1]!), input.pluginVersion, input.manifestHash, input.config);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/internal/plugins/actions/encode") {
          const input = parseBody(encodeActionSchema, body);
          return json(200, await options.manager.encodeAction({ installationId: input.installationId, deviceId: input.deviceId, actionId: input.actionId, actionInput: input.input }));
        }
      } catch (error) { return failure(error); }
      return json(404, { error: "not_found" });
    },
  });
  return { url: server.url.toString(), stop: async () => { await server.stop(true); } };
}
