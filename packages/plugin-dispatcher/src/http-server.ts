/**
 * Dispatcher-side synchronous HTTP endpoint for action encoding (§6.1:
 * "确实需要同步 RPC 时必须设置 deadline、response size limit 和 circuit
 * breaker").
 *
 * The API never executes plugin encoders (container isolation, review fix)
 * and does not know host URLs — it calls THIS endpoint; the dispatcher
 * routes to the right host through the same supervised client used for
 * events (handshake, deadline, frame cap, bench circuit).
 *
 *   POST /encode-action  {plugin_id, action_id, input}
 *   → {cmd, args, schema_version} | mapped JSON-RPC error
 */

import {
  ENCODE_ACTION_METHOD,
  type EncodeActionParams,
} from "@soulcloud/plugin-sdk";
import { pluginManifests } from "@soulcloud/plugins";
import { findAction, validateEncodedAction } from "@soulcloud/core";
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
}

export interface DispatcherHttpHandle {
  port: number;
  url: string;
  close(): Promise<void>;
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
        return jsonResponse({ error: "not_found", message: "not found" }, 404);
      }
      if (
        options.authToken &&
        request.headers.get("authorization") !== `Bearer ${options.authToken}`
      ) {
        return jsonResponse({ error: "unauthorized", message: "authentication required" }, 401);
      }
      let body: { plugin_id?: unknown; action_id?: unknown; input?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "invalid_request", message: "invalid JSON" }, 400);
      }
      const pluginId = typeof body.plugin_id === "string" ? body.plugin_id : "";
      const actionId = typeof body.action_id === "string" ? body.action_id : "";
      if (!pluginId || !actionId) {
        return jsonResponse(
          { error: "invalid_request", message: "plugin_id and action_id are required" },
          400,
        );
      }
      const manifest = pluginManifests.get(pluginId);
      const action = manifest ? findAction(manifest, actionId) : null;
      if (!manifest || !action) {
        return jsonResponse(
          { error: "unknown_action", message: `plugin ${pluginId} does not declare action "${actionId}"` },
          404,
        );
      }

      let result: unknown;
      try {
        const client = await supervisor.ensureClient(
          manifest.id,
          manifest.version,
          manifest.apiVersion,
        );
        const params: EncodeActionParams = {
          actionId,
          input: body.input ?? {},
        };
        result = await client.request(ENCODE_ACTION_METHOD, params, options.encodeTimeoutMs);
      } catch (error) {
        if (error instanceof PluginHostTimeoutError) {
          supervisor.killHost(manifest.id);
          return jsonResponse(
            { error: "encode_timeout", message: `plugin host did not answer within ${options.encodeTimeoutMs}ms` },
            504,
          );
        }
        if (error instanceof PluginHostUnavailableError) {
          supervisor.killHost(manifest.id);
          return jsonResponse(
            { error: "plugin_unavailable", message: (error as Error).message },
            503,
          );
        }
        const coded = error as Error & { code?: string };
        if (coded.code === "invalid_params") {
          return jsonResponse({ error: "invalid_action_input", message: coded.message }, 400);
        }
        if (coded.code === "overloaded") {
          return jsonResponse({ error: "overloaded", message: "plugin host overloaded" }, 503);
        }
        if (coded.code === "response_too_large") {
          return jsonResponse({ error: "response_too_large", message: coded.message }, 413);
        }
        return jsonResponse(
          { error: "handler_error", message: `plugin handler error: ${coded.message}` },
          502,
        );
      }

      try {
        const encoded = (result ?? {}) as {
          cmd?: unknown;
          args?: unknown;
          schemaVersion?: unknown;
        };
        const validated = validateEncodedAction({
          action,
          cmd: typeof encoded.cmd === "string" ? encoded.cmd : "",
          args: encoded.args,
          schemaVersion: typeof encoded.schemaVersion === "number" ? encoded.schemaVersion : 0,
        });
        return jsonResponse({
          cmd: validated.command.cmd,
          args: validated.command.args ?? [],
          schema_version: validated.schemaVersion,
        });
      } catch (error) {
        // The host returned a structurally invalid encoding — deterministic
        // plugin bug, not a transport problem.
        logger.error("host returned an invalid action encoding", {
          pluginId: manifest.id,
          actionId,
          error: (error as Error).message,
        });
        return jsonResponse(
          { error: "invalid_action_output", message: (error as Error).message },
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
