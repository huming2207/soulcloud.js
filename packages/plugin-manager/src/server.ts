import { PluginManager } from "./manager";

export interface PluginManagerServerOptions { hostname: string; port: number; serviceToken: string; manager: PluginManager; }
function json(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function authorized(request: Request, token: string): boolean { return request.headers.get("authorization") === `Bearer ${token}`; }

export function startPluginManagerServer(options: PluginManagerServerOptions): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health/live") return json(200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/health/ready") return json(200, { status: "ready" });
      if (!url.pathname.startsWith("/internal/plugins/")) return json(404, { error: "not_found" });
      if (!authorized(request, options.serviceToken)) return json(401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/plugins/catalog") return json(200, { plugins: options.manager.listCatalog() });
      return json(404, { error: "not_found" });
    },
  });
  return { url: server.url.toString(), stop: () => server.stop(true) };
}
