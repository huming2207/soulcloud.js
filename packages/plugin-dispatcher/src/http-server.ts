/**
 * Dispatcher-side synchronous HTTP MessagePack-RPC endpoint for action
 * encoding (§6.1: "确实需要同步 RPC 时必须设置 deadline、response size
 * limit 和 circuit breaker").
 *
 * The API never executes plugin encoders (container isolation, review fix)
 * and does not know host URLs — it calls THIS endpoint; the dispatcher
 * routes to the right host through the same supervised client used for
 * events (handshake, deadline, frame cap, bench circuit).
 *
 *   POST /encode-action  MessagePack-RPC(action.encode)
 *   → MessagePack-RPC result {cmd, args, schemaVersion} | error
 */

import {
  ENCODE_ACTION_METHOD,
  RPC_CONTENT_TYPE,
  RPC_VERSION,
  decodeRpcMessage,
  encodeRpcMessage,
  isRpcRequest,
  type EncodeActionParams,
  type RpcError,
  type RpcResponse,
} from "@soulcloud/plugin-sdk";
import { pluginManifests } from "@soulcloud/plugins";
import { findAction, validateEncodedAction } from "@soulcloud/core";
import type { HostSupervisor } from "./supervisor";
import type { SupervisorLogger } from "./supervisor";
import { PluginHostTimeoutError, PluginHostUnavailableError } from "./rpc-client";
import {
  assertRpcValueBudget,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";

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

function errorResponse(
  id: number,
  code: RpcError["code"],
  message: string,
): RpcResponse {
  return { version: RPC_VERSION, id, ok: false, error: { code, message } };
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
        return rpcResponse(
          errorResponse(0, "unauthorized", "authentication required"),
          options.maxFrameBytes,
          401,
        );
      }
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith(RPC_CONTENT_TYPE)
      ) {
        return new Response("MessagePack content required", { status: 415 });
      }
      let body: Uint8Array;
      try {
        body = new Uint8Array(await request.arrayBuffer());
      } catch {
        return rpcResponse(
          errorResponse(0, "parse_error", "invalid MessagePack"),
          options.maxFrameBytes,
          400,
        );
      }
      let parsed: unknown;
      try {
        parsed = decodeRpcMessage(body, options.maxFrameBytes);
      } catch {
        return rpcResponse(
          errorResponse(0, "parse_error", "invalid MessagePack"),
          options.maxFrameBytes,
          400,
        );
      }
      if (!isRpcRequest(parsed)) {
        return rpcResponse(
          errorResponse(0, "invalid_request", "invalid MessagePack-RPC request"),
          options.maxFrameBytes,
          400,
        );
      }
      const requestId = parsed.id;
      if (parsed.method !== ENCODE_ACTION_METHOD) {
        return rpcResponse(
          errorResponse(requestId, "method_not_found", "unknown dispatcher method"),
          options.maxFrameBytes,
          404,
        );
      }
      const params = parsed.params as {
        pluginId?: unknown;
        actionId?: unknown;
        input?: unknown;
      } | undefined;
      const pluginId = typeof params?.pluginId === "string" ? params.pluginId : "";
      const actionId = typeof params?.actionId === "string" ? params.actionId : "";
      if (!pluginId || !actionId) {
        return rpcResponse(
          errorResponse(requestId, "invalid_params", "pluginId and actionId are required"),
          options.maxFrameBytes,
          400,
        );
      }
      const manifest = pluginManifests.get(pluginId);
      const action = manifest ? findAction(manifest, actionId) : null;
      if (!manifest || !action) {
        return rpcResponse(
          errorResponse(
            requestId,
            "unknown_action",
            `plugin ${pluginId} does not declare action "${actionId}"`,
          ),
          options.maxFrameBytes,
          404,
        );
      }

      let result: unknown;
      try {
        if (options.valueBudget) {
          assertRpcValueBudget(params?.input ?? {}, options.valueBudget);
        }
        const client = await supervisor.ensureClient(
          manifest.id,
          manifest.version,
          manifest.apiVersion,
        );
        const hostParams: EncodeActionParams = {
          actionId,
          input: params?.input ?? {},
        };
        result = await client.request(
          ENCODE_ACTION_METHOD,
          hostParams,
          options.encodeTimeoutMs,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("RPC ")) {
          return rpcResponse(
            errorResponse(requestId, "invalid_params", error.message),
            options.maxFrameBytes,
            400,
          );
        }
        if (error instanceof PluginHostTimeoutError) {
          supervisor.killHost(manifest.id);
          return rpcResponse(
            errorResponse(
              requestId,
              "encode_timeout",
              `plugin host did not answer within ${options.encodeTimeoutMs}ms`,
            ),
            options.maxFrameBytes,
            504,
          );
        }
        if (error instanceof PluginHostUnavailableError) {
          supervisor.killHost(manifest.id);
          return rpcResponse(
            errorResponse(requestId, "plugin_unavailable", (error as Error).message),
            options.maxFrameBytes,
            503,
          );
        }
        const coded = error as Error & { code?: string };
        if (coded.code === "invalid_action_output") {
          return rpcResponse(
            errorResponse(
              requestId,
              "invalid_action_output",
              coded.message ?? "invalid action output",
            ),
            options.maxFrameBytes,
            502,
          );
        }
        if (coded.code === "invalid_params") {
          return rpcResponse(
            errorResponse(requestId, "invalid_action_input", coded.message ?? "invalid action input"),
            options.maxFrameBytes,
            400,
          );
        }
        if (coded.code === "overloaded") {
          return rpcResponse(
            errorResponse(requestId, "overloaded", "plugin host overloaded"),
            options.maxFrameBytes,
            503,
          );
        }
        if (coded.code === "response_too_large") {
          return rpcResponse(
            errorResponse(requestId, "response_too_large", coded.message ?? "response too large"),
            options.maxFrameBytes,
            413,
          );
        }
        return rpcResponse(
          errorResponse(
            requestId,
            "handler_error",
            `plugin handler error: ${coded.message ?? "unknown error"}`,
          ),
          options.maxFrameBytes,
          502,
        );
      }

      try {
        const encoded = (result ?? {}) as {
          cmd?: unknown;
          args?: unknown;
          schemaVersion?: unknown;
        };
        if (options.valueBudget) {
          assertRpcValueBudget(encoded, options.valueBudget);
        }
        const validated = validateEncodedAction({
          action,
          cmd: typeof encoded.cmd === "string" ? encoded.cmd : "",
          args: encoded.args,
          schemaVersion: typeof encoded.schemaVersion === "number" ? encoded.schemaVersion : 0,
        });
        return rpcResponse(
          {
            version: RPC_VERSION,
            id: requestId,
            ok: true,
            result: {
              cmd: validated.command.cmd,
              args: validated.command.args ?? [],
              schemaVersion: validated.schemaVersion,
            },
          },
          options.maxFrameBytes,
        );
      } catch (error) {
        // The host returned a structurally invalid encoding — deterministic
        // plugin bug, not a transport problem.
        logger.error("host returned an invalid action encoding", {
          pluginId: manifest.id,
          actionId,
          error: (error as Error).message,
        });
        return rpcResponse(
          errorResponse(requestId, "invalid_action_output", (error as Error).message),
          options.maxFrameBytes,
          502,
        );
      }
    },
  });

  logger.info("dispatcher http endpoint listening", {
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
