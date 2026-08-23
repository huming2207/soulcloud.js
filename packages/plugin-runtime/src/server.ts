import { RPCLink } from "@orpc/client/websocket";
import { createContractClientFactory } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import {
  MANAGER_TO_PLUGIN_PREFIX,
  PLUGIN_TO_MANAGER_PREFIX,
  PLUGIN_API_VERSION,
  RPC_PATH,
  RPC_PROTOCOL_HEADER,
  RPC_VERSION,
  assertRpcValueBudget,
  canonicalJson,
  managerToPluginContract,
  pluginToManagerContract,
  sha256Hex,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";
import {
  validateActionInput,
  definePlugin,
  validateEntityUpdates,
  type CommandArgument,
  type PluginDefinition,
  type PluginEntityState,
  type PluginManifest,
} from "@soulcloud/plugin-sdk";

const DEFAULT_BUDGET: RpcValueBudget = {
  maxDepth: 32,
  maxNodes: 4096,
  maxArrayItems: 4096,
  maxStringBytes: 65_536,
  maxBlobs: 16,
  maxBlobBytes: 65_536,
  maxTotalBlobBytes: 256 * 1024,
};

export interface PluginRuntimeOptions {
  hostname: string;
  port: number;
  authToken: string;
  maxFrameBytes?: number;
  maxConcurrentOperations?: number;
  backpressureBytes?: number;
  idleTimeoutSeconds?: number;
  valueBudget?: Partial<RpcValueBudget>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginRuntimeHandle {
  manifest: PluginManifest;
  manifestHash: string;
  url: string;
  close(): Promise<void>;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function rpcError(code: string, message: string): never {
  throw new ORPCError("BAD_REQUEST", { message: `${code}: ${message}` });
}

function commandWire(args: CommandArgument[]): Array<{ name: string; value: string | number | bigint | boolean | null | Blob }> {
  return args.map((argument) => {
    const keys = Object.keys(argument);
    if (keys.length !== 1) rpcError("INVALID_PLUGIN_OUTPUT", "command argument must contain one key");
    const name = keys[0]!;
    const value = argument[name];
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) rpcError("INVALID_PLUGIN_OUTPUT", "invalid command argument value");
    if (value instanceof Uint8Array) return { name, value: new Blob([value]) };
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value === null) return { name, value };
    rpcError("INVALID_PLUGIN_OUTPUT", "command argument must be scalar");
  });
}

function entityValueToWire(value: string | number | boolean | Uint8Array | ArrayBuffer | undefined): string | number | boolean | Blob | undefined {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return new Blob([value]);
  return value;
}

async function entityStateFromWire(state: {
  entityKey: string;
  value: string | number | boolean | null | Blob;
  quality: PluginEntityState["quality"];
  sourceTimestamp: string | null;
  ingestedAt: string;
  alarm: PluginEntityState["alarm"];
} | null): Promise<PluginEntityState | null> {
  if (!state) return null;
  const value = state.value;
  if (!(value instanceof Blob)) return { ...state, value };
  return { ...state, value: new Uint8Array(await value.arrayBuffer()) };
}

function createBridge(ws: Bun.ServerWebSocket<unknown>) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let readyState: 0 | 1 | 2 | 3 = 1;
  const dispatch = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    get readyState() { return readyState; },
    send(data: string | Uint8Array<ArrayBuffer>) { return ws.send(data); },
    addEventListener(type: string, listener: (event: unknown) => void) { let set = listeners.get(type); if (!set) listeners.set(type, set = new Set()); set.add(listener); },
    removeEventListener(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener); },
    dispatch,
    close() { readyState = 3; dispatch("close", {}); },
  };
}

export async function startPluginRuntime(definition: PluginDefinition, options: PluginRuntimeOptions): Promise<PluginRuntimeHandle> {
  if (options.authToken.length < 32) throw new Error("plugin RPC auth token must be at least 32 characters");
  const runtimeDefinition = definePlugin(definition);
  const manifest = runtimeDefinition.manifest;
  const manifestHash = await sha256Hex(canonicalJson(manifest));
  const budget = { ...DEFAULT_BUDGET, ...options.valueBudget };
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
  const maxConcurrent = options.maxConcurrentOperations ?? 8;
  const log = options.log ?? ((message, fields) => console.log(`[soulcloud-plugin:${manifest.id}] ${message}`, fields ?? ""));
  let activeConnections = 0;
  const server = Bun.serve<{ connection?: RuntimeConnection; handshaken: boolean }>({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: maxFrameBytes,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return json(200, { status: "ok", pluginId: manifest.id, pluginVersion: manifest.version, manifestHash });
      if (url.pathname !== RPC_PATH || request.method !== "GET") return json(404, { error: "not_found" });
      if (request.headers.get("x-soulcloud-rpc-protocol") !== RPC_PROTOCOL_HEADER) return json(400, { error: "unsupported_rpc_protocol" });
      if (request.headers.get("authorization") !== `Bearer ${options.authToken}`) return json(401, { error: "unauthorized" });
      if (activeConnections >= 16) return json(503, { error: "connection_limit" });
      if (!server.upgrade(request, { data: { handshaken: false } })) return json(400, { error: "upgrade_failed" });
      return undefined as unknown as Response;
    },
    websocket: {
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: options.backpressureBytes ?? 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: options.idleTimeoutSeconds ?? 60,
      open(ws) {
        activeConnections += 1;
        ws.data.connection = createRuntimeConnection(ws, runtimeDefinition, manifestHash, budget, maxConcurrent, log);
      },
      message(ws, message) {
        const connection = ws.data.connection;
        const data = message instanceof ArrayBuffer ? message : typeof message === "string" ? message : message instanceof Uint8Array ? message : new Uint8Array(message as ArrayBuffer);
        const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
        if (bytes > maxFrameBytes) { ws.close(1009, "RPC frame too large"); return; }
        if (!hasPrefix(data, MANAGER_TO_PLUGIN_PREFIX) && !hasPrefix(data, PLUGIN_TO_MANAGER_PREFIX)) {
          ws.close(1002, "invalid RPC prefix");
          return;
        }
        if (!connection) return;
        connection.receive(data, {
          isHandshaken: () => ws.data.handshaken,
          markHandshaken: () => { ws.data.handshaken = true; },
        });
      },
      close(ws) { activeConnections = Math.max(0, activeConnections - 1); void ws.data.connection?.close(); ws.data.connection = undefined; },
      drain(ws) { ws.data.connection?.bridge.dispatch("drain", {}); },
    },
  });
  log("plugin listening", { url: server.url.toString(), version: manifest.version, manifestHash });
  return { manifest, manifestHash, url: server.url.toString().replace(/\/$/, ""), close: async () => { await server.stop(true); } };
}

function hasPrefix(data: string | ArrayBuffer | ArrayBufferView, prefix: string): boolean {
  if (typeof data === "string") return data.startsWith(prefix);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const expected = new TextEncoder().encode(prefix);
  if (bytes.byteLength < expected.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) if (bytes[index] !== expected[index]) return false;
  return true;
}

interface RuntimeConnection {
  bridge: ReturnType<typeof createBridge>;
  handler: RPCHandler<any>;
  receive(data: string | ArrayBuffer | ArrayBufferView, context: { isHandshaken: () => boolean; markHandshaken: () => void }): void;
  close(): Promise<void>;
}

function createRuntimeConnection(ws: Bun.ServerWebSocket<{ connection?: RuntimeConnection; handshaken: boolean }>, definition: PluginDefinition, manifestHash: string, budget: RpcValueBudget, maxConcurrent: number, log: (message: string, fields?: Record<string, unknown>) => void): RuntimeConnection {
  const bridge = createBridge(ws);
  const reverse = createContractClientFactory(new RPCLink({ connect: () => bridge, encodePeerMessage: { prefix: PLUGIN_TO_MANAGER_PREFIX }, decodePeerMessage: { prefix: PLUGIN_TO_MANAGER_PREFIX } }))(pluginToManagerContract);
  let running = 0;
  const implemented = implement(managerToPluginContract).$context<{ isHandshaken: () => boolean; markHandshaken: () => void }>();
  const router = {
    system: {
      handshake: implemented.system.handshake.handler(({ input, context }) => {
        if (input.rpcProtocolVersion !== RPC_VERSION || input.pluginApiVersion !== PLUGIN_API_VERSION || input.pluginId !== definition.manifest.id) rpcError("HANDSHAKE_MISMATCH", "plugin identity mismatch");
        context.markHandshaken();
        return { rpcProtocolVersion: RPC_VERSION, pluginApiVersion: PLUGIN_API_VERSION, pluginId: definition.manifest.id, pluginVersion: definition.manifest.version, manifest: definition.manifest, manifestHash, capabilities: { reverseRpcVersion: 1 as const, blob: true, ssr: definition.render ? { version: 1 as const, streaming: false } : false } };
      }),
      ping: implemented.system.ping.handler(({ input, context }) => { if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "handshake required"); return input; }),
    },
    action: {
      encode: implemented.action.encode.handler(({ input, context }) => {
        if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "handshake required");
        if (running >= maxConcurrent) rpcError("OVERLOADED", "plugin operation limit reached");
        const descriptor = definition.manifest.actions.find((action) => action.id === input.actionId);
        const encoder = definition.encodeAction?.[input.actionId];
        if (!descriptor || !encoder) rpcError("INVALID_ACTION_INPUT", "unknown action");
        const check = validateActionInput(descriptor.inputSchema, input.input);
        if (!check.ok) rpcError("INVALID_ACTION_INPUT", check.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; "));
        running += 1;
        try { const args = encoder(input.input); assertRpcValueBudget(args, budget); return { command: descriptor.wire.command, args: commandWire(args), schemaVersion: descriptor.wire.schemaVersion }; }
        catch (error) { rpcError("INVALID_PLUGIN_OUTPUT", (error as Error).message); }
        finally { running -= 1; }
      }),
    },
    plugin: {
      handleEvent: implemented.plugin.handleEvent.handler(async ({ input, context }) => {
        if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "handshake required");
        if (!definition.onEvent) return { updates: [], logs: [] };
        const profile = definition.manifest.profiles.find((item) => item.id === input.device.profileId && item.version === input.device.profileVersion);
        if (!profile) rpcError("INVALID_EVENT_INPUT", "unknown device profile");
        try {
          assertRpcValueBudget(input.event.payload, budget);
        } catch (error) {
          rpcError("INVALID_EVENT_INPUT", (error as Error).message);
        }
        if (running >= maxConcurrent) rpcError("OVERLOADED", "plugin operation limit reached");
        running += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.deadlineMs);
        try {
          const ctx = {
            operationId: input.operationId,
            signal: controller.signal,
            installation: input.installation,
            device: input.device,
            getEntity: async (entityKey: string) => entityStateFromWire(await reverse.context.entities.get({ operationId: input.operationId, operationToken: input.operationToken, deadlineMs: input.deadlineMs, entityKey })),
            enqueueCommand: async (command: string, args: CommandArgument[] = []) => { const result = await reverse.context.commands.enqueue({ operationId: input.operationId, operationToken: input.operationToken, deadlineMs: input.deadlineMs, command, args: commandWire(args) }); return result.accepted ? undefined : undefined; },
          };
          const result = await definition.onEvent(ctx, { id: input.event.id, seq: typeof input.event.seq === "number" ? BigInt(input.event.seq) : input.event.seq, kind: input.event.kind, schema: input.event.schema, receivedAt: input.event.receivedAt, payload: input.event.payload, installation: input.installation, device: input.device });
          const updates = result?.updates ?? [];
          try {
            validateEntityUpdates(profile.entities, updates);
            assertRpcValueBudget(updates, budget);
          } catch (error) {
            rpcError("INVALID_PLUGIN_OUTPUT", (error as Error).message);
          }
          return {
            updates: updates.map((update) => ({ ...update, value: entityValueToWire(update.value) })),
            logs: result?.logs ?? [],
          };
        } finally { clearTimeout(timer); running -= 1; }
      }),
    },
    ui: {
      render: implemented.ui.render.handler(async ({ input, context }) => {
        if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "handshake required");
        const renderer = definition.render?.[input.routeId];
        if (!renderer) rpcError("NOT_FOUND", "unknown UI route");
        if (running >= maxConcurrent) rpcError("OVERLOADED", "plugin operation limit reached");
        running += 1;
        try {
          const result = await renderer(input);
          assertRpcValueBudget(result, budget);
          return result;
        } finally {
          running -= 1;
        }
      }),
      handleAction: implemented.ui.handleAction.handler(async ({ input, context }) => {
        if (!context.isHandshaken()) rpcError("UNAUTHORIZED", "handshake required");
        const actionHandler = definition.handleAction?.[input.routeId];
        if (!actionHandler) rpcError("NOT_FOUND", "unknown UI route");
        if (running >= maxConcurrent) rpcError("OVERLOADED", "plugin operation limit reached");
        running += 1;
        try {
          const result = await actionHandler(input.action, input) as { redirect?: string; errors?: { field: string; message: string }[] };
          assertRpcValueBudget(result, budget);
          return result;
        } finally {
          running -= 1;
        }
      }),
    },
  };
  const handler = new RPCHandler(router, { encodePeerMessage: { prefix: MANAGER_TO_PLUGIN_PREFIX }, decodePeerMessage: { prefix: MANAGER_TO_PLUGIN_PREFIX } });
  return {
    bridge,
    handler,
    receive(data, context) {
      if (hasPrefix(data, PLUGIN_TO_MANAGER_PREFIX)) {
        // A reverse response may be needed by the currently running forward
        // handler. Dispatch it immediately; putting it on receiveTail would
        // deadlock handleEvent -> reverse call -> response.
        bridge.dispatch("message", { data });
        return;
      }
      void handler.message(
        bridge,
        data as string | ArrayBuffer | Pick<Uint8Array<ArrayBuffer>, "buffer" | "byteLength" | "byteOffset">,
        { context },
      ).catch(() => ws.close(1011, "RPC handler error"));
    },
    async close() { bridge.close(); await handler.close(bridge); log("plugin connection closed"); },
  };
}
