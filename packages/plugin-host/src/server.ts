/**
 * Containerised Plugin Host HTTP JSON-RPC server.
 *
 * One container serves one compile-time plugin. The host has no database or
 * application credentials. Docker/Kubernetes is responsible for process
 * isolation, memory limits, health checks and restart policy.
 */

import { pluginManifests, pluginWorkerLoaders } from "@soulcloud/plugins";
import {
  DEFAULT_MAX_FRAME_BYTES,
  HANDLE_EVENT_METHOD,
  HANDSHAKE_METHOD,
  RPC_VERSION,
  validateEventUpdates,
  type HandleEventParams,
  type HandleEventResult,
  type LogNotificationParams,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
} from "@soulcloud/plugin-sdk";
import type { PluginManifest, PluginWorker } from "@soulcloud/plugin-sdk";
import { createPluginContext } from "./context";

export interface PluginHostOptions {
  pluginId: string;
  hostname?: string;
  port: number;
  authToken?: string;
  maxFrameBytes?: number;
  maxConcurrentHandlers?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginHostHandle {
  manifest: PluginManifest;
  hostname: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const DEFAULT_MAX_CONCURRENT_HANDLERS = 8;
const MAX_LOGS_PER_EVENT = 32;
const MAX_LOG_MESSAGE_BYTES = 4 * 1024;
const MAX_LOG_FIELDS_BYTES = 16 * 1024;

type HostEventResult = HandleEventResult & { logs?: LogNotificationParams[] };

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function errorResponse(
  id: number,
  code: RpcError["code"],
  message: string,
): RpcResponse {
  return { id, ok: false, error: { code, message } };
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
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? ((message, fields) => console.log(message, fields ?? ""));
  let running = 0;

  const server = Bun.serve({
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
      if (url.pathname !== "/rpc") return new Response("not found", { status: 404 });
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });
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
      let body: string;
      try {
        body = await request.text();
      } catch {
        return new Response("request too large", { status: 413 });
      }
      if (Buffer.byteLength(body, "utf8") > maxFrameBytes) {
        return new Response("request too large", { status: 413 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return jsonResponse(errorResponse(0, "parse_error", "invalid JSON"));
      }
      if (!isRequest(parsed)) {
        return jsonResponse(errorResponse(0, "invalid_request", "invalid JSON-RPC request"));
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
    async close() {
      server.stop(true);
    },
  };
}

function isRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RpcRequest>;
  return (
    typeof request.id === "number" &&
    Number.isSafeInteger(request.id) &&
    request.id >= 0 &&
    typeof request.method === "string" &&
    request.method.length > 0 &&
    typeof request.deadlineMs === "number" &&
    Number.isFinite(request.deadlineMs) &&
    request.deadlineMs > 0
  );
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
  if (request.method === HANDSHAKE_METHOD) {
    return jsonResponse({
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
  if (request.method !== HANDLE_EVENT_METHOD) {
    return jsonResponse(
      errorResponse(request.id, "method_not_found", `unknown method "${request.method}"`),
    );
  }
  if (env.getRunning() >= env.maxConcurrent) {
    return jsonResponse(
      errorResponse(request.id, "overloaded", "too many concurrent handler executions"),
    );
  }

  env.onRunningDelta(1);
  try {
    const params = request.params as HandleEventParams | undefined;
    if (!params || typeof params.eventId !== "string") {
      return jsonResponse(errorResponse(request.id, "invalid_params", "missing event parameters"));
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
        if (serializedBytes(fields) > MAX_LOG_FIELDS_BYTES) boundedFields = { truncated: true };
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
      return jsonResponse(
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
      return jsonResponse(
        errorResponse(request.id, "invalid_params", `invalid plugin output — ${detail}`),
      );
    }
    const payload: HostEventResult = { updates, logs };
    const bytes = serializedBytes(payload);
    if (bytes > env.maxFrameBytes) {
      return jsonResponse(
        errorResponse(
          request.id,
          "response_too_large",
          `response of ${bytes} bytes exceeds the ${env.maxFrameBytes}-byte ceiling`,
        ),
      );
    }
    return jsonResponse({ id: request.id, ok: true, result: payload });
  } catch (error) {
    return jsonResponse(
      errorResponse(request.id, "handler_error", (error as Error).message ?? "plugin handler threw"),
    );
  } finally {
    env.onRunningDelta(-1);
  }
}
