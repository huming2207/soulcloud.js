import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API origin for the dev/preview proxies: the Elysia server
// (packages/api, :8080) by default; VITE_API_TARGET overrides it (the
// web E2E script runs its own API on a dedicated port to avoid the
// Bun SO_REUSEPORT pitfall). The same /v1 + /health prefixes are
// expected behind the reverse proxy in production, so the frontend
// never needs to know the API origin.
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8080";

const proxy = {
  // ws: true so WebSocket upgrades (/v1/ws/logs, /v1/ws/commands, /v1/ws/ota)
  // reach the API through the dev/preview proxy, not just plain HTTP
  "/v1": { target: apiTarget, ws: true },
  "/health": apiTarget,
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // listen on all interfaces: the dev console must be reachable from
    // other machines on the LAN (the API and broker already bind
    // 0.0.0.0; the dev-only proxy forwards /v1 and the WS streams)
    host: true,
    proxy,
  },
  preview: {
    port: 5173,
    proxy,
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks: split the big MUI/emotion, React, router and
        // query libraries out of the initial bundle so (a) the initial chunk
        // stays small and (b) unchanged vendor chunks keep their hashes for
        // long-term browser caching. Grouping is deliberately coarse (4
        // groups) - MUI split per-package produces worse cache behaviour.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // route-lazy libraries stay in their lazy chunks: pulling
          // @mui/x-data-grid or xterm into a vendor chunk would move them
          // into the initial load, which is worse (verified: a blanket
          // vendor-misc group grew the initial gzip beyond the old single
          // bundle). Everything not matched below keeps the default
          // rollup placement.
          if (id.includes("@mui/x-") || id.includes("@xterm")) return undefined;
          if (id.includes("@mui") || id.includes("@emotion")) return "vendor-mui";
          if (id.includes("react-router")) return "vendor-router";
          if (id.includes("@tanstack")) return "vendor-query";
          if (
            id.includes("/react/") ||
            id.includes("react-dom") ||
            id.includes("scheduler")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
