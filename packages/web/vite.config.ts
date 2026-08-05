import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API calls to the Elysia server (packages/api, :8080).
// The same /v1 + /health prefixes are expected behind the reverse proxy in
// production, so the frontend never needs to know the API origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
