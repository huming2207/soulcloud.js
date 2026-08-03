import { Elysia } from "elysia";
import { loadConfig } from "./config";
import { ping } from "./db";

const config = loadConfig();

// API_BIND_ADDRESS is "host:port" (e.g. "0.0.0.0:8080")
const [hostname, port] = config.API_BIND_ADDRESS.split(":");
if (!hostname || !port) {
  console.error(
    `Invalid API_BIND_ADDRESS: ${config.API_BIND_ADDRESS} (expected host:port)`,
  );
  process.exit(1);
}

const app = new Elysia()
  .get("/health/live", () => ({ status: "ok" }))
  .get("/health/ready", async ({ set }) => {
    const ok = await ping();
    if (!ok) {
      set.status = 503;
      return { status: "not_ready" };
    }
    return { status: "ready" };
  });

app.listen({ hostname, port: Number(port) });
console.log(
  `[soulcloudjs] API server listening on ${config.API_BIND_ADDRESS}`,
);
