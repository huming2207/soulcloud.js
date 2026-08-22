/** Plugin Host container entry point. */

import { startPluginHost } from "./server";

interface ParsedArgs {
  pluginId?: string;
  hostname?: string;
  port?: number;
  authToken?: string;
  maxFrameBytes?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--plugin" && next) {
      args.pluginId = next;
      index += 1;
    } else if (arg === "--hostname" && next) {
      args.hostname = next;
      index += 1;
    } else if (arg === "--port" && next) {
      const port = Number.parseInt(next, 10);
      if (Number.isSafeInteger(port) && port >= 0 && port <= 65_535) args.port = port;
      index += 1;
    } else if (arg === "--auth-token" && next) {
      args.authToken = next;
      index += 1;
    } else if (arg === "--max-frame-bytes" && next) {
      const size = Number.parseInt(next, 10);
      if (Number.isSafeInteger(size) && size > 0) args.maxFrameBytes = size;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const pluginId = args.pluginId ?? process.env.PLUGIN_ID;
const hostname = args.hostname ?? process.env.PLUGIN_HOST_BIND ?? "0.0.0.0";
const port = args.port ?? Number.parseInt(process.env.PLUGIN_HOST_PORT ?? "8090", 10);
const authToken = args.authToken ?? process.env.PLUGIN_HOST_AUTH_TOKEN;
const maxFrameBytes = args.maxFrameBytes ?? Number.parseInt(
  process.env.PLUGIN_HOST_MAX_FRAME_BYTES ?? String(1024 * 1024),
  10,
);
const websocketBackpressureLimit = Number.parseInt(
  process.env.PLUGIN_HOST_WS_BACKPRESSURE_BYTES ?? String(4 * 1024 * 1024),
  10,
);
const websocketIdleTimeoutSeconds = Number.parseInt(
  process.env.PLUGIN_HOST_WS_IDLE_TIMEOUT_SECONDS ?? "60",
  10,
);
const maxWebSocketConnections = Number.parseInt(
  process.env.PLUGIN_HOST_MAX_WS_CONNECTIONS ?? "16",
  10,
);

if (!pluginId || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  console.error(
    "usage: bun packages/plugin-host/src/index.ts --plugin <plugin-id> [--hostname <bind>] [--port <n>] [--auth-token <token>]",
  );
  process.exit(64);
}

const handle = await startPluginHost({
  pluginId,
  hostname,
  port,
  authToken,
  maxFrameBytes,
  websocketBackpressureLimit,
  websocketIdleTimeoutSeconds,
  maxWebSocketConnections,
});

console.log(
  `[plugin-host] ready plugin=${handle.manifest.id} version=${handle.manifest.version} url=${handle.url}`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[plugin-host] received ${signal}, shutting down`);
  await handle.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
