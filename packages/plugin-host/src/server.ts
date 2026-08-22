/**
 * Containerised Plugin Host server. It exposes the legacy HTTP MessagePack-RPC
 * endpoint and the preferred bidirectional oRPC WebSocket endpoint.
 *
 * One container serves one compile-time plugin. The host has no database or
 * application credentials. Docker/Kubernetes is responsible for process
 * isolation, memory limits, health checks and restart policy.
 */

import { pluginManifests, pluginWorkerLoaders } from "@soulcloud/plugins";
import {
  DEFAULT_MAX_FRAME_BYTES,
  RPC_CONTENT_TYPE,
  ENCODE_ACTION_METHOD,
  HANDLE_EVENT_METHOD,
  HANDSHAKE_METHOD,
  RPC_VERSION,
  decodeRpcMessage,
  encodeRpcMessage,
  isRpcRequest,
  validateActionInput,
  validateEventUpdates,
  type EncodeActionParams,
  type EncodeActionResult,
  type HandleEventParams,
  type HandleEventResult,
  type LogNotificationParams,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
} from "@soulcloud/plugin-sdk";
import type { PluginManifest, PluginWorker } from "@soulcloud/plugin-sdk";
import { createPluginContext } from "./context";
import { createPluginHostWsConnection, type PluginHostWsConnection } from "./ws-server";
import { PLUGIN_RPC_PROTOCOL_HEADER } from "@soulcloud/plugin-rpc-contract";

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
const DEFAULT_WS_BACKPRESSURE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_WS_IDLE_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_WS_CONNECTIONS = 16;
const MAX_LOGS_PER_EVENT = 32;
const MAX_LOG_MESSAGE_BYTES = 4 * 1024;
const MAX_LOG_FIELDS_BYTES = 16 * 1024;

type HostEventResult = HandleEventResult & { logs?: LogNotificationParams[] };

function encodedBytes(value: unknown, maxFrameBytes: number): number {
  try {
    return encodeRpcMessage(value, maxFrameBytes).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function errorResponse(
  id: number,
  code: RpcError["code"],
  message: string,
): RpcResponse {
  return { version: RPC_VERSION, id, ok: false, error: { code, message } };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function rpcResponse(
  value: RpcResponse,
  maxFrameBytes: number,
  status = 200,
): Response {
  return new Response(encodeRpcMessage(value, maxFrameBytes), {
    status,
    headers: { "content-type": RPC_CONTENT_TYPE },
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
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? ((message, fields) => console.log(message, fields ?? ""));
  let running = 0;
  let activeWebSocketConnections = 0;

  type HostWebSocketData = { connection?: PluginHostWsConnection; handshaken: boolean };
  const server = Bun.serve<HostWebSocketData>({
    hostname,
    port: options.port,
    maxRequestBodySize: maxFrameBytes,
    async fetch(request): Promise<Response> {
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
        if (activeWebSocketConnections >= (options.maxWebSocketConnections ?? DEFAULT_MAX_WS_CONNECTIONS)) {
          return new Response("too many WebSocket connections", { status: 503 });
        }
        if (request.headers.get("x-soulcloud-rpc-protocol") !== PLUGIN_RPC_PROTOCOL_HEADER) {
          return new Response("unsupported RPC protocol", { status: 400 });
        }
        if (options.authToken && request.headers.get("authorization") !== `Bearer ${options.authToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
        if (!server.upgrade(request, { data: { handshaken: false } })) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }
      if (url.pathname !== "/rpc") return new Response("not found", { status: 404 });
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });
      }
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith(RPC_CONTENT_TYPE)
      ) {
        return new Response("MessagePack content required", { status: 415 });
      }
      if (options.authToken) {
        const authorization = request.headers.get("authorization");
        if (authorization !== `Bearer ${options.authToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > maxFrameBytes) {
        return new Response("request too large", { status: 413 });
      }
      let body: Uint8Array;
      try {
        body = new Uint8Array(await request.arrayBuffer());
      } catch {
        return new Response("request too large", { status: 413 });
      }
      if (body.byteLength > maxFrameBytes) {
        return new Response("request too large", { status: 413 });
      }
      let parsed: unknown;
      try {
        parsed = decodeRpcMessage(body, maxFrameBytes);
      } catch {
        return rpcResponse(
          errorResponse(0, "parse_error", "invalid MessagePack"),
          maxFrameBytes,
        );
      }
      if (!isRpcRequest(parsed)) {
        return rpcResponse(
          errorResponse(0, "invalid_request", "invalid MessagePack-RPC request"),
          maxFrameBytes,
        );
      }
      return handleRequest(parsed, worker, manifest, {
        maxFrameBytes,
        maxConcurrent,
        getRunning: () => running,
        onRunningDelta: (delta) => {
          running += delta;
        },
        log,
      });
    },
    websocket: {
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: options.websocketBackpressureLimit ?? DEFAULT_WS_BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      idleTimeout: options.websocketIdleTimeoutSeconds ?? DEFAULT_WS_IDLE_TIMEOUT_SECONDS,
      open(ws) {
        activeWebSocketConnections += 1;
        ws.data.handshaken = false;
        ws.data.connection = createPluginHostWsConnection(ws, {
          manifest,
          worker,
          maxConcurrentHandlers: maxConcurrent,
          log,
        });
      },
      message(ws, message) {
        const connection = ws.data.connection;
        if (!connection) {
          ws.close(1011, "connection not initialized");
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
      close(ws) {
        activeWebSocketConnections = Math.max(0, activeWebSocketConnections - 1);
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

interface HandlerEnv {
  maxFrameBytes: number;
  maxConcurrent: number;
  getRunning: () => number;
  onRunningDelta: (delta: number) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

async function handleRequest(
  request: RpcRequest,
  worker: PluginWorker,
  manifest: PluginManifest,
  env: HandlerEnv,
): Promise<Response> {
  const respond = (value: RpcResponse): Response =>
    rpcResponse(value, env.maxFrameBytes);

  if (request.method === HANDSHAKE_METHOD) {
    return respond({
      version: RPC_VERSION,
      id: request.id,
      ok: true,
      result: {
        rpcVersion: RPC_VERSION,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        apiVersion: manifest.apiVersion,
      },
    });
  }
  if (request.method === ENCODE_ACTION_METHOD) {
    // Encoding is plugin code, so it runs here — never in the API or
    // dispatcher. It shares the handler concurrency gate and the request
    // deadline with event handling; a broken encoder blocks at most this
    // host's own event loop (container health checks own the restart).
    if (env.getRunning() >= env.maxConcurrent) {
      return respond(
        errorResponse(request.id, "overloaded", "too many concurrent executions"),
      );
    }
    env.onRunningDelta(1);
    try {
      const params = request.params as EncodeActionParams | undefined;
      if (!params || typeof params.actionId !== "string") {
        return respond(errorResponse(request.id, "invalid_params", "missing action parameters"));
      }
      const action = manifest.actions.find((a) => a.id === params.actionId);
      if (!action) {
        return respond(
          errorResponse(request.id, "invalid_params", `unknown action "${params.actionId}"`),
        );
      }
      const input = params.input ?? {};
      const inputCheck = validateActionInput(action.inputSchema, input);
      if (!inputCheck.ok) {
        const detail = inputCheck.failures
          .map((f) => `${f.field} ${f.error}`)
          .join("; ");
        return respond(
          errorResponse(request.id, "invalid_params", `invalid action input — ${detail}`),
        );
      }
      let args;
      try {
        args = action.wire.encode(input);
      } catch (error) {
        return respond(
          errorResponse(
            request.id,
            "handler_error",
            `action encoder threw: ${(error as Error).message ?? "encoder threw"}`,
          ),
        );
      }
      if (!Array.isArray(args) || args.length > 256) {
        return respond(
          errorResponse(
            request.id,
            "invalid_action_output",
            "encoder returned no array or too many arguments",
          ),
        );
      }
      for (const [index, arg] of args.entries()) {
        if (!arg || typeof arg !== "object" || Array.isArray(arg) || Object.keys(arg).length !== 1) {
          return respond(
            errorResponse(
              request.id,
              "invalid_action_output",
              `encoder argument #${index} must be a single-key map`,
            ),
          );
        }
        const value = Object.values(arg)[0];
        const scalar =
          typeof value === "string" ||
          typeof value === "boolean" ||
          typeof value === "bigint" ||
          value === null ||
          value instanceof Uint8Array ||
          (typeof value === "number" && Number.isFinite(value));
        if (!scalar) {
          return respond(
            errorResponse(
              request.id,
              "invalid_action_output",
              `encoder argument #${index} has a non-scalar value`,
            ),
          );
        }
      }
      const result: EncodeActionResult = {
        cmd: action.wire.command,
        args,
        schemaVersion: action.wire.schemaVersion,
      };
      if (encodedBytes(result, env.maxFrameBytes) > env.maxFrameBytes) {
        return respond(
          errorResponse(request.id, "response_too_large", "encoded action exceeds the frame ceiling"),
        );
      }
      return respond({ version: RPC_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      return respond(
        errorResponse(request.id, "handler_error", (error as Error).message ?? "action encoder threw"),
      );
    } finally {
      env.onRunningDelta(-1);
    }
  }
  if (request.method !== HANDLE_EVENT_METHOD) {
    return respond(
      errorResponse(request.id, "method_not_found", `unknown method "${request.method}"`),
    );
  }
  if (env.getRunning() >= env.maxConcurrent) {
    return respond(
      errorResponse(request.id, "overloaded", "too many concurrent handler executions"),
    );
  }

  env.onRunningDelta(1);
  try {
    const params = request.params as HandleEventParams | undefined;
    if (!params || typeof params.eventId !== "string") {
      return respond(errorResponse(request.id, "invalid_params", "missing event parameters"));
    }
    const deadlineMs = Math.min(request.deadlineMs, 10 * 60 * 1000);
    const logs: LogNotificationParams[] = [];
    const emitLog = (
      level: LogNotificationParams["level"],
      message: string,
      fields?: Record<string, unknown>,
    ) => {
      if (logs.length >= MAX_LOGS_PER_EVENT) return;
      const boundedMessage = Buffer.byteLength(message, "utf8") > MAX_LOG_MESSAGE_BYTES
        ? `${message.slice(0, MAX_LOG_MESSAGE_BYTES)}…`
        : message;
      let boundedFields = fields;
      if (fields !== undefined) {
        if (encodedBytes(fields, MAX_LOG_FIELDS_BYTES) > MAX_LOG_FIELDS_BYTES) {
          boundedFields = { truncated: true };
        }
      }
      const entry: LogNotificationParams = {
        level,
        message: boundedMessage,
        fields: boundedFields,
        pluginId: manifest.id,
        installationId: params.installation.id,
        projectId: params.installation.projectId,
        operationId: params.eventId,
      };
      logs.push(entry);
      env.log(`[plugin-host ${manifest.id}] [${level}] ${boundedMessage}`, boundedFields);
    };
    const ctx = createPluginContext(
      params.installation,
      AbortSignal.timeout(deadlineMs),
      {
        pluginId: manifest.id,
        installationId: params.installation.id,
        projectId: params.installation.projectId,
        operationId: params.eventId,
      },
      emitLog,
      { getDeviceUid: async () => params.device.deviceUid },
    );
    const result = await worker.onEvent(ctx, {
      eventId: params.eventId,
      eventKind: params.eventKind,
      schemaVersion: params.schemaVersion,
      payload: params.payload,
      device: params.device,
      receivedAt: params.receivedAt,
    });
    const updates = result?.updates ?? [];
    const profile = manifest.profiles.find(
      (candidate) =>
        candidate.id === params.device.profileId &&
        candidate.version === params.device.profileVersion,
    );
    if (!profile) {
      return respond(
        errorResponse(
          request.id,
          "internal_error",
          `host has no profile ${params.device.profileId} v${params.device.profileVersion} for plugin ${manifest.id}`,
        ),
      );
    }
    const check = validateEventUpdates(profile.entities, updates);
    if (!check.ok) {
      const detail = check.failures
        .slice(0, 5)
        .map((failure) => `${failure.entityKey}: ${failure.error}`)
        .join("; ");
      return respond(
        errorResponse(request.id, "invalid_params", `invalid plugin output — ${detail}`),
      );
    }
    const payload: HostEventResult = { updates, logs };
    const bytes = encodedBytes(payload, env.maxFrameBytes);
    if (bytes > env.maxFrameBytes) {
      return respond(
        errorResponse(
          request.id,
          "response_too_large",
          `response of ${bytes} bytes exceeds the ${env.maxFrameBytes}-byte ceiling`,
        ),
      );
    }
    return respond({ version: RPC_VERSION, id: request.id, ok: true, result: payload });
  } catch (error) {
    return respond(
      errorResponse(request.id, "handler_error", (error as Error).message ?? "plugin handler threw"),
    );
  } finally {
    env.onRunningDelta(-1);
  }
}
