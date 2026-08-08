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
    proxy,
  },
  preview: {
    port: 5173,
    proxy,
  },
});
