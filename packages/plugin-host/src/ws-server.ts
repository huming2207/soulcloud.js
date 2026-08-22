import { RPCLink } from "@orpc/client/websocket";
import { createContractClientFactory } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import {
  PLUGIN_RPC_D2H_PREFIX,
  PLUGIN_RPC_H2D_PREFIX,
  dispatcherToHostContract,
  hostToDispatcherContract,
  assertRpcValueBudget,
  type RpcValueBudget,
  type CommandArgumentWire,
  type EntityGetOutput,
} from "@soulcloud/plugin-rpc-contract";
import type { EntityStateSnapshot, PluginManifest, PluginWorker } from "@soulcloud/plugin-sdk";
import { validateActionInput, validateEventUpdates } from "@soulcloud/plugin-sdk";
import { createPluginContext, type PluginContextBindings } from "./context";

const MAX_LOGS_PER_EVENT = 32;
const MAX_LOG_MESSAGE_BYTES = 4 * 1024;

function rpcError(code: string, message: string): never {
  throw new ORPCError(code as never, { message });
}

type Listener = (event: unknown) => void;

/** Adapt Bun's server socket to the browser-style socket expected by RPCLink. */
function createServerWebSocketBridge(ws: Bun.ServerWebSocket<unknown>) {
  const listeners = new Map<string, Set<Listener>>();
  let readyState: 0 | 1 | 2 | 3 = 1;
  const bridge = {
    get readyState() {
      return readyState;
    },
    send(data: string | Uint8Array<ArrayBuffer>) {
      return ws.send(data);
    },
    addEventListener(type: string, listener: Listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, set = new Set());
      set.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    close() {
      readyState = 3;
      bridge.dispatch("close", { code: 1000, reason: "closed" });
    },
  };
  return bridge;
}

function snapshotToWire(snapshot: EntityStateSnapshot | null): EntityGetOutput {
  if (!snapshot) return null;
  return {
    entityKey: snapshot.entityKey,
    value: snapshot.value,
    quality: snapshot.quality,
    sourceTimestamp: snapshot.sourceTimestamp,
    ingestedAt: snapshot.ingestedAt,
    alarm: snapshot.alarm,
  };
}

export interface PluginHostWsRuntimeOptions {
  manifest: PluginManifest;
  worker: PluginWorker;
  maxConcurrentHandlers: number;
  log: (message: string, fields?: Record<string, unknown>) => void;
  valueBudget: RpcValueBudget;
}

export interface PluginHostWsConnection {
  bridge: ReturnType<typeof createServerWebSocketBridge>;
  handler: RPCHandler<any>;
  reverseClient: any;
  close(): Promise<void>;
}

/** Builds one connection's dispatcher-facing router and reverse client. */
export function createPluginHostWsConnection(
  ws: Bun.ServerWebSocket<unknown>,
  options: PluginHostWsRuntimeOptions,
): PluginHostWsConnection {
  const bridge = createServerWebSocketBridge(ws);
  const reverseLink = new RPCLink({
    connect: () => bridge,
    encodePeerMessage: { prefix: PLUGIN_RPC_H2D_PREFIX },
    decodePeerMessage: { prefix: PLUGIN_RPC_H2D_PREFIX },
  });
  const reverseClient = createContractClientFactory(reverseLink)(hostToDispatcherContract);
  let running = 0;
  const activeSignals = new Set<AbortController>();

  type HostContext = {
    reverse: typeof reverseClient;
    isHandshaken: () => boolean;
    markHandshaken: () => void;
  };
  const implemented = implement(dispatcherToHostContract).$context<HostContext>();
  const router = {
    system: {
      handshake: implemented.system.handshake.handler(({ input, context }) => {
      if (input.rpcVersion !== 2 || input.pluginId !== options.manifest.id || input.pluginVersion !== options.manifest.version || input.apiVersion !== options.manifest.apiVersion) {
        rpcError("UNAUTHORIZED", "plugin handshake identity mismatch");
      }
      context.markHandshaken();
      return {
      rpcVersion: 2 as const,
      pluginId: options.manifest.id,
      pluginVersion: options.manifest.version,
      apiVersion: options.manifest.apiVersion,
      };
      }),
      ping: implemented.system.ping.handler(({ input, context }) => {
      if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "plugin handshake required");
      return input;
      }),
    },
    action: {
      encode: implemented.action.encode.handler(async ({ input, context }) => {
      if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "plugin handshake required");
      if (running >= options.maxConcurrentHandlers) rpcError("OVERLOADED", "too many concurrent executions");
      running += 1;
      try {
        try {
          assertRpcValueBudget(input.input, options.valueBudget);
        } catch (error) {
          rpcError("INVALID_ACTION_INPUT", (error as Error).message);
        }
        const action = options.manifest.actions.find((candidate) => candidate.id === input.actionId);
        if (!action) rpcError("INVALID_ACTION_INPUT", `unknown action "${input.actionId}"`);
        const check = validateActionInput(action.inputSchema, input.input ?? {});
        if (!check.ok) {
          rpcError("INVALID_ACTION_INPUT", `invalid action input — ${check.failures.map((f) => `${f.field} ${f.error}`).join("; ")}`);
        }
        let args;
        try {
          args = action.wire.encode(input.input);
        } catch (error) {
          rpcError("HANDLER_ERROR", `action encoder threw: ${(error as Error).message}`);
        }
        if (!Array.isArray(args) || args.length > 256) rpcError("INVALID_ACTION_OUTPUT", "encoder returned an invalid argument array");
        try {
          // Check the plugin-owned Uint8Array values before wrapping them in
          // Blob objects, so rejected output does not allocate a second copy.
          assertRpcValueBudget(args, options.valueBudget);
        } catch (error) {
          rpcError("INVALID_ACTION_OUTPUT", (error as Error).message);
        }
        const output = {
          cmd: action.wire.command,
          args: args.map((arg) => {
            const name = Object.keys(arg)[0]!;
            const value = arg[name];
            if (value === undefined) rpcError("INVALID_ACTION_OUTPUT", "encoder argument contains undefined");
            if (Object.keys(arg).length !== 1) rpcError("INVALID_ACTION_OUTPUT", "encoder argument must be a single-key map");
            const scalar = value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint" || value instanceof Uint8Array || (typeof value === "number" && Number.isFinite(value));
            if (!scalar) rpcError("INVALID_ACTION_OUTPUT", "encoder argument contains a non-scalar value");
            return { name, value: value instanceof Uint8Array ? new Blob([value]) : value };
          }),
          schemaVersion: action.wire.schemaVersion,
        };
        try {
          assertRpcValueBudget(output, options.valueBudget);
        } catch (error) {
          rpcError("INVALID_ACTION_OUTPUT", (error as Error).message);
        }
        return output;
      } finally {
        running -= 1;
      }
      }),
    },
    plugin: {
      handleEvent: implemented.plugin.handleEvent.handler(async ({ input, context }) => {
      if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "plugin handshake required");
      if (running >= options.maxConcurrentHandlers) rpcError("OVERLOADED", "too many concurrent executions");
      running += 1;
      let operationController: AbortController | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        try {
          assertRpcValueBudget(input.payload, options.valueBudget);
        } catch (error) {
          rpcError("INVALID_EVENT_INPUT", (error as Error).message);
        }
        const profile = options.manifest.profiles.find(
          (candidate) => candidate.id === input.device.profileId && candidate.version === input.device.profileVersion,
        );
        if (!profile) rpcError("INTERNAL_SERVER_ERROR", `unknown profile ${input.device.profileId} v${input.device.profileVersion}`);
        const emitLog = (
          level: "debug" | "info" | "warn" | "error",
          message: string,
          fields?: Record<string, unknown>,
        ) => {
          const boundedMessage = Buffer.byteLength(message, "utf8") > MAX_LOG_MESSAGE_BYTES
            ? `${message.slice(0, MAX_LOG_MESSAGE_BYTES)}…`
            : message;
          let boundedFields = fields;
          if (fields !== undefined) {
            try {
              assertRpcValueBudget(fields, options.valueBudget);
            } catch {
              boundedFields = { truncated: true };
            }
          }
          options.log(`[plugin-host ${options.manifest.id}] [${level}] ${boundedMessage}`, boundedFields);
        };
        const bindings: PluginContextBindings = {
          getDeviceUid: async () => input.device.deviceUid,
          getEntity: async (entityKey, signal) => snapshotToWire(await context.reverse.context.entities.get({
            operationId: input.operationId,
            operationToken: input.operationToken,
            entityKey,
          }, { signal })),
          enqueueCommand: async (command, args, signal) => {
            try {
              assertRpcValueBudget({ command, args }, options.valueBudget);
            } catch (error) {
              rpcError("INVALID_PLUGIN_OUTPUT", (error as Error).message);
            }
            const wireArgs = args.map((arg) => {
              const name = Object.keys(arg)[0]!;
              const value = arg[name];
              if (value === undefined) rpcError("INVALID_ACTION_OUTPUT", "command argument contains undefined");
              return { name, value: value instanceof Uint8Array ? new Blob([value]) : value };
            });
            await context.reverse.context.commands.enqueue({
              operationId: input.operationId,
              operationToken: input.operationToken,
              command,
              args: wireArgs,
            }, { signal });
          },
        };
        operationController = new AbortController();
        deadlineTimer = setTimeout(() => operationController?.abort(), input.deadlineMs);
        activeSignals.add(operationController);
        const ctx = createPluginContext(
          input.installation,
          operationController.signal,
          {
            pluginId: options.manifest.id,
            installationId: input.installation.id,
            projectId: input.installation.projectId,
            operationId: input.operationId,
          },
          emitLog,
          bindings,
        );
        const result = await options.worker.onEvent(ctx, {
          eventId: input.eventId,
          eventKind: input.eventKind,
          schemaVersion: input.schemaVersion,
          payload: input.payload,
          device: input.device,
          receivedAt: input.receivedAt,
        });
        const updates = result?.updates ?? [];
        try {
          assertRpcValueBudget(updates, options.valueBudget);
        } catch (error) {
          rpcError("INVALID_PLUGIN_OUTPUT", (error as Error).message);
        }
        const check = validateEventUpdates(profile.entities, updates);
        if (!check.ok) {
          rpcError("INVALID_PLUGIN_OUTPUT", `invalid plugin output — ${check.failures.slice(0, 5).map((f) => `${f.entityKey}: ${f.error}`).join("; ")}`);
        }
        return { updates };
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        // Returning from the parent handler seals the operation. Abort the
        // shared context signal so an unawaited reverse call cannot outlive
        // the operation and keep transport/database work alive.
        operationController?.abort();
        if (operationController) activeSignals.delete(operationController);
        running -= 1;
      }
      }),
    },
  };
  const handler = new RPCHandler(router, {
    encodePeerMessage: { prefix: PLUGIN_RPC_D2H_PREFIX },
    decodePeerMessage: { prefix: PLUGIN_RPC_D2H_PREFIX },
  });
  return {
    bridge,
    handler,
    reverseClient,
    async close() {
      for (const controller of activeSignals) controller.abort();
      activeSignals.clear();
      bridge.close();
      await handler.close(ws);
    },
  };
}
