/**
 * Dispatcher-side JSON control endpoint for synchronous Action encoding.
 *
 * This is API → dispatcher plumbing, not the Plugin Host protocol. The
 * dispatcher still calls the isolated Host over the single oRPC/WebSocket
 * connection. Binary and bigint command arguments use explicit JSON wrappers
 * because this endpoint no longer has a MessagePack dependency.
 */

import { pluginManifests } from "@soulcloud/plugins";
import { findAction, validateEncodedAction } from "@soulcloud/core";
import {
  assertRpcValueBudget,
  decodePluginJsonValue,
  encodePluginJsonValue,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";
import type { HostSupervisor } from "./supervisor";
import type { SupervisorLogger } from "./supervisor";
import { PluginHostTimeoutError, PluginHostUnavailableError } from "./rpc-client";

export interface DispatcherHttpOptions {
  port: number;
  hostname?: string;
  /** Bearer token shared with the API; required when set. */
  authToken?: string;
  /** Per-request deadline for the host encode round trip. */
  encodeTimeoutMs: number;
  maxFrameBytes: number;
  valueBudget?: RpcValueBudget;
}

export interface DispatcherHttpHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function jsonResponse(value: unknown, status = 200, maxBytes?: number): Response {
  const body = JSON.stringify(value);
  if (maxBytes !== undefined && Buffer.byteLength(body, "utf8") > maxBytes) {
    return new Response(
      JSON.stringify({ error: "response_too_large", message: "response exceeds the JSON frame limit" }),
      {
        status: 413,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  const boundedMessage = message.length > 4096 ? `${message.slice(0, 4096)}…` : message;
  return jsonResponse({ error: code, message: boundedMessage }, status);
}

export function startDispatcherHttp(
  supervisor: HostSupervisor,
  options: DispatcherHttpOptions,
  logger: SupervisorLogger,
): DispatcherHttpHandle {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    maxRequestBodySize: options.maxFrameBytes,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/encode-action" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (
        options.authToken &&
        request.headers.get("authorization") !== `Bearer ${options.authToken}`
      ) {
        return jsonError("unauthorized", "authentication required", 401);
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return jsonError("invalid_request", "JSON content required", 415);
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > options.maxFrameBytes) {
        return jsonError("request_too_large", "request exceeds the JSON body limit", 413);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonError("parse_error", "invalid JSON", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonError("invalid_request", "expected a JSON object", 400);
      }
      const input = body as { pluginId?: unknown; actionId?: unknown; input?: unknown };
      const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
      const actionId = typeof input.actionId === "string" ? input.actionId : "";
      if (!pluginId || !actionId) {
        return jsonError("invalid_params", "pluginId and actionId are required", 400);
      }
      const manifest = pluginManifests.get(pluginId);
      const action = manifest ? findAction(manifest, actionId) : null;
      if (!manifest || !action) {
        return jsonError(
          "unknown_action",
          `plugin ${pluginId} does not declare action "${actionId}"`,
          404,
        );
      }

      let result: unknown;
      try {
        if (options.valueBudget) assertRpcValueBudget(input.input ?? {}, options.valueBudget);
        const client = await supervisor.ensureClient(manifest.id, manifest.version, manifest.apiVersion);
        result = await client.request(
          "action.encode",
          { actionId, input: input.input ?? {} },
          options.encodeTimeoutMs,
        );
      } catch (error) {
        if (error instanceof PluginHostTimeoutError) {
          supervisor.killHost(manifest.id);
          return jsonError("encode_timeout", `plugin host did not answer within ${options.encodeTimeoutMs}ms`, 504);
        }
        if (error instanceof PluginHostUnavailableError) {
          supervisor.killHost(manifest.id);
          return jsonError("plugin_unavailable", error.message, 503);
        }
        const coded = error as Error & { code?: string };
        if (coded.code === "invalid_action_output") return jsonError("invalid_action_output", coded.message, 502);
        if (coded.code === "invalid_params") return jsonError("invalid_action_input", coded.message, 400);
        if (coded.code === "overloaded" || coded.code === "callback_overloaded") {
          return jsonError("overloaded", "plugin host overloaded", 503);
        }
        if (coded.code === "response_too_large") return jsonError("response_too_large", coded.message, 413);
        return jsonError("handler_error", coded.message ?? "plugin handler error", 502);
      }

      try {
        const encoded = (result ?? {}) as { cmd?: unknown; args?: unknown; schemaVersion?: unknown };
        if (options.valueBudget) assertRpcValueBudget(encoded, options.valueBudget);
        const decodedArgs = Array.isArray(encoded.args)
          ? encoded.args.map((arg) => {
              if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
              const entries = Object.entries(arg);
              if (entries.length === 2 && typeof (arg as { name?: unknown }).name === "string" && "value" in arg) {
                const named = arg as { name: string; value: unknown };
                return { [named.name]: decodePluginJsonValue(named.value) };
              }
              return entries.length === 1
                ? { [entries[0]![0]]: decodePluginJsonValue(entries[0]![1]) }
                : arg;
            })
          : encoded.args;
        const validated = validateEncodedAction({
          action,
          cmd: typeof encoded.cmd === "string" ? encoded.cmd : "",
          args: decodedArgs,
          schemaVersion: typeof encoded.schemaVersion === "number" ? encoded.schemaVersion : 0,
        });
        return jsonResponse({
          cmd: validated.command.cmd,
          args: encodePluginJsonValue(validated.command.args ?? []),
          schemaVersion: validated.schemaVersion,
        }, 200, options.maxFrameBytes);
      } catch (error) {
        logger.error("host returned an invalid action encoding", {
          pluginId: manifest.id,
          actionId,
          error: (error as Error).message,
        });
        return jsonError("invalid_action_output", (error as Error).message, 502);
      }
    },
  });

  logger.info("dispatcher JSON endpoint listening", {
    url: server.url.toString(),
    encodeTimeoutMs: options.encodeTimeoutMs,
  });

  const actualPort = server.port ?? options.port;
  return {
    port: actualPort,
    url: server.url.toString().replace(/\/$/, ""),
    async close() {
      server.stop(true);
    },
  };
}
