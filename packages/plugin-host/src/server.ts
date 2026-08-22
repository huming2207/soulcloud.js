/** Containerised Plugin Host server using bidirectional oRPC over WebSocket. */

import { pluginManifests, pluginWorkerLoaders } from "@soulcloud/plugins";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import { createPluginHostWsConnection, type PluginHostWsConnection } from "./ws-server";
import {
  PLUGIN_RPC_D2H_PREFIX,
  PLUGIN_RPC_H2D_PREFIX,
  PLUGIN_RPC_PROTOCOL_HEADER,
  matchesRpcPrefix,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";

export interface PluginHostOptions {
  pluginId: string;
  hostname?: string;
  port: number;
  authToken?: string;
  maxFrameBytes?: number;
  maxConcurrentHandlers?: number;
  websocketBackpressureLimit?: number;
  websocketIdleTimeoutSeconds?: number;
  maxWebSocketConnections?: number;
  valueBudget?: Partial<RpcValueBudget>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginHostHandle {
  manifest: PluginManifest;
  hostname: string;
  port: number;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

const DEFAULT_MAX_CONCURRENT_HANDLERS = 8;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_WS_BACKPRESSURE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_WS_IDLE_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_WS_CONNECTIONS = 16;
const DEFAULT_RPC_VALUE_BUDGET: RpcValueBudget = {
  maxDepth: 32,
  maxNodes: 4096,
  maxArrayItems: 4096,
  maxStringBytes: 65_536,
  maxBlobs: 16,
  maxBlobBytes: 65_536,
  maxTotalBlobBytes: 256 * 1024,
};

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function startPluginHost(
  options: PluginHostOptions,
): Promise<PluginHostHandle> {
  const manifest = pluginManifests.get(options.pluginId);
  const loadWorker = pluginWorkerLoaders.get(options.pluginId);
  if (!manifest || !loadWorker) {
    throw new Error(`unknown plugin "${options.pluginId}" in the registry`);
  }
  const worker = await loadWorker();
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxConcurrent =
    options.maxConcurrentHandlers ?? DEFAULT_MAX_CONCURRENT_HANDLERS;
  const valueBudget = { ...DEFAULT_RPC_VALUE_BUDGET, ...options.valueBudget };
  requirePositiveInteger("maxFrameBytes", maxFrameBytes);
  requirePositiveInteger("maxConcurrentHandlers", maxConcurrent);
  requirePositiveInteger(
    "websocketBackpressureLimit",
    options.websocketBackpressureLimit ?? DEFAULT_WS_BACKPRESSURE_LIMIT,
  );
  requirePositiveInteger(
    "websocketIdleTimeoutSeconds",
    options.websocketIdleTimeoutSeconds ?? DEFAULT_WS_IDLE_TIMEOUT_SECONDS,
  );
  requirePositiveInteger(
    "maxWebSocketConnections",
    options.maxWebSocketConnections ?? DEFAULT_MAX_WS_CONNECTIONS,
  );
  for (const [name, value] of Object.entries(valueBudget)) {
    requirePositiveInteger(`valueBudget.${name}`, value);
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? ((message, fields) => console.log(message, fields ?? ""));
  let activeWebSocketConnections = 0;
  let reservedWebSocketConnections = 0;

  type HostWebSocketData = {
    connection?: PluginHostWsConnection;
    handshaken: boolean;
    counted: boolean;
  };
  const server = Bun.serve<HostWebSocketData>({
    hostname,
    port: options.port,
    maxRequestBodySize: maxFrameBytes,
    fetch(request): Response {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({
          ok: true,
          pluginId: manifest.id,
          pluginVersion: manifest.version,
        });
      }
      if (url.pathname === "/rpc/ws") {
        if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
        const maxWebSocketConnections = options.maxWebSocketConnections ?? DEFAULT_MAX_WS_CONNECTIONS;
        if (activeWebSocketConnections + reservedWebSocketConnections >= maxWebSocketConnections) {
          return new Response("too many WebSocket connections", { status: 503 });
        }
        if (request.headers.get("x-soulcloud-rpc-protocol") !== PLUGIN_RPC_PROTOCOL_HEADER) {
          return new Response("unsupported RPC protocol", { status: 400 });
        }
        if (options.authToken && request.headers.get("authorization") !== `Bearer ${options.authToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
        reservedWebSocketConnections += 1;
        if (!server.upgrade(request, { data: { handshaken: false, counted: false } })) {
          reservedWebSocketConnections = Math.max(0, reservedWebSocketConnections - 1);
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: options.websocketBackpressureLimit ?? DEFAULT_WS_BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      idleTimeout: options.websocketIdleTimeoutSeconds ?? DEFAULT_WS_IDLE_TIMEOUT_SECONDS,
      open(ws) {
        reservedWebSocketConnections = Math.max(0, reservedWebSocketConnections - 1);
        activeWebSocketConnections += 1;
        ws.data.counted = true;
        ws.data.handshaken = false;
        ws.data.connection = createPluginHostWsConnection(ws, {
          manifest,
          worker,
          maxConcurrentHandlers: maxConcurrent,
          log,
          valueBudget,
        });
      },
      message(ws, message) {
        const connection = ws.data.connection;
        if (!connection) {
          ws.close(1011, "connection not initialized");
          return;
        }
        if (!matchesRpcPrefix(message, PLUGIN_RPC_D2H_PREFIX) && !matchesRpcPrefix(message, PLUGIN_RPC_H2D_PREFIX)) {
          ws.close(1002, "unknown RPC prefix");
          return;
        }
        // Both oRPC peers observe every frame and filter by their direction
        // prefix. Dispatch to the reverse client before the request handler
        // so response frames are available in the same event turn.
        connection.bridge.dispatch("message", { data: message });
        void connection.handler.message(ws, message, {
          context: {
            reverse: connection.reverseClient,
            isHandshaken: () => ws.data.handshaken,
            markHandshaken: () => { ws.data.handshaken = true; },
          },
        });
      },
      drain(ws) {
        ws.data.connection?.bridge.dispatch("drain", {});
      },
      close(ws) {
        if (ws.data.counted) {
          activeWebSocketConnections = Math.max(0, activeWebSocketConnections - 1);
        } else {
          reservedWebSocketConnections = Math.max(0, reservedWebSocketConnections - 1);
        }
        void ws.data.connection?.close();
        ws.data.connection = undefined;
      },
    },
  });

  log("plugin-host listening", {
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    url: server.url.toString(),
  });
  const actualPort = server.port ?? options.port;
  return {
    manifest,
    hostname,
    port: actualPort,
    url: server.url.toString().replace(/\/$/, ""),
    wsUrl: server.url.toString().replace(/^http/, "ws").replace(/\/$/, "") + "/rpc/ws",
    async close() {
      server.stop(true);
    },
  };
}
