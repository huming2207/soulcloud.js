/**
 * Minimal static file server for the built SPA (production image).
 *
 * Serves packages/web/dist with an SPA fallback to index.html. TLS,
 * /v1 proxying to the API and host-based routing are handled by the
 * reverse proxy in front (traefik in the reference deployment) — this
 * server only needs to hand out files.
 */
import { serve } from "bun";

const DIST = new URL("./dist/", import.meta.url).pathname;
const PORT = Number(process.env.WEB_PORT ?? 8080);

// vite emits hashed filenames for assets; safe to cache forever
const ASSET_RE = /\.(js|css|svg|png|jpg|jpeg|gif|woff2?)(\?.*)?$/;

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (path === "/") path = "/index.html";

    const file = Bun.file(DIST + path.slice(1));
    if (await file.exists()) {
      const headers = new Headers();
      headers.set(
        "cache-control",
        ASSET_RE.test(path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      return new Response(file, { headers });
    }

    // SPA fallback: unknown non-file routes render the app shell;
    // real file paths (with an extension) that do not exist are 404s
    if (/\.[a-z0-9]+$/i.test(path)) {
      return new Response("not found", { status: 404 });
    }
    const index = Bun.file(DIST + "index.html");
    if (await index.exists()) {
      return new Response(index, {
        headers: { "cache-control": "no-cache" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[web] serving ${DIST} on :${PORT}`);
void server;
