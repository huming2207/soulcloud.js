import { RPCLink } from "@orpc/client/websocket";
import { createContractClientFactory } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import {
  MANAGER_TO_PLUGIN_PREFIX,
  PLUGIN_TO_MANAGER_PREFIX,
  RPC_PATH,
  RPC_PROTOCOL_HEADER,
  RPC_VERSION,
  hasRpcPrefix,
  managerToPluginContract,
  pluginToManagerContract,
  type CommandEnqueueInput,
  type EntityGetInput,
  type EntityGetOutput,
  type PluginCallInput,
  type UiDataInput,
  type HandshakeOutput,
} from "@soulcloud/plugin-rpc-contract";

export interface ReverseHandlers {
  entityGet(input: EntityGetInput, signal: AbortSignal, connectionId: string): Promise<EntityGetOutput>;
  commandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }>;
  pluginCall(input: PluginCallInput, signal: AbortSignal, connectionId: string): Promise<unknown>;
  uiGetData(input: UiDataInput, signal: AbortSignal, connectionId: string): Promise<unknown>;
}

export interface PluginConnectionOptions {
  pluginId: string;
  endpoint: string;
  authToken: string;
  maxFrameBytes: number;
  maxPendingRequests: number;
  backpressureBytes: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reverseHandlers: ReverseHandlers;
  onDisconnect?: (connectionId: string) => void;
}

export class PluginConnectionError extends Error {}
export class PluginConnectionTimeout extends PluginConnectionError {}

export class PluginConnection {
  private socket: WebSocket | null = null;
  private forward: any = null;
  private reverseHandler: RPCHandler<any> | null = null;
  private bridge: ReturnType<typeof createClientBridge> | null = null;
  private connecting: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pending = 0;
  private incomingTail: Promise<void> = Promise.resolve();
  private closed = false;
  private handshaken = false;
  private connectionId = crypto.randomUUID();
  private manifestInfo: HandshakeOutput | null = null;

  constructor(private readonly options: PluginConnectionOptions) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new PluginConnectionError("PLUGIN_ENDPOINTS must use ws:// or wss://");
    if (!url.pathname || url.pathname === "/") url.pathname = RPC_PATH;
    if (url.pathname !== RPC_PATH) throw new PluginConnectionError(`plugin endpoint must end in ${RPC_PATH}`);
    this.options.endpoint = url.toString();
  }

  get isOpen(): boolean { return !this.closed && this.handshaken && this.socket?.readyState === WebSocket.OPEN; }
  get manifest(): HandshakeOutput | null { return this.manifestInfo; }
  get id(): string { return this.connectionId; }

  async connect(): Promise<HandshakeOutput> {
    if (this.isOpen && this.manifestInfo) return this.manifestInfo;
    if (this.closed) throw new PluginConnectionError("connection is closed");
    if (this.connecting) { await this.connecting; return this.manifestInfo!; }
    this.connecting = this.openSocket();
    try { await this.connecting; return this.manifestInfo!; } finally { this.connecting = null; }
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.options.endpoint, { headers: { "x-soulcloud-rpc-protocol": RPC_PROTOCOL_HEADER, authorization: `Bearer ${this.options.authToken}` } });
      this.connectionId = crypto.randomUUID();
      this.socket = socket;
      this.incomingTail = Promise.resolve();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* already closed */ }
        this.onClose(socket);
        reject(error);
      };
      socket.addEventListener("error", () => fail(new PluginConnectionError("plugin WebSocket error")));
      socket.addEventListener("open", () => {
        const bridge = createClientBridge(socket, this.options.backpressureBytes);
        this.bridge = bridge;
        const reverseImpl = implement(pluginToManagerContract).$context<{ signal: AbortSignal }>();
        const handler = {
          system: { ping: reverseImpl.system.ping.handler(({ input }) => input) },
          context: {
            entities: { get: reverseImpl.context.entities.get.handler(({ input, context }) => this.options.reverseHandlers.entityGet(input, context.signal, this.connectionId)) },
            commands: { enqueue: reverseImpl.context.commands.enqueue.handler(({ input, context }) => this.options.reverseHandlers.commandEnqueue(input, context.signal, this.connectionId)) },
            plugins: { callScoped: reverseImpl.context.plugins.callScoped.handler(({ input, context }) => this.options.reverseHandlers.pluginCall(input, context.signal, this.connectionId)) },
            ui: { getData: reverseImpl.context.ui.getData.handler(({ input, context }) => this.options.reverseHandlers.uiGetData(input, context.signal, this.connectionId)) },
          },
        };
        this.reverseHandler = new RPCHandler(handler, { encodePeerMessage: { prefix: PLUGIN_TO_MANAGER_PREFIX }, decodePeerMessage: { prefix: PLUGIN_TO_MANAGER_PREFIX } });
        this.forward = createContractClientFactory(new RPCLink({ connect: () => bridge, encodePeerMessage: { prefix: MANAGER_TO_PLUGIN_PREFIX }, decodePeerMessage: { prefix: MANAGER_TO_PLUGIN_PREFIX } }))(managerToPluginContract);
        socket.addEventListener("message", (event) => {
          this.incomingTail = this.incomingTail
            .then(() => this.handleSocketMessage(socket, bridge, event))
            .catch(() => socket.close(1002, "invalid reverse RPC frame"));
        });
        socket.addEventListener("error", (event) => bridge.dispatch("error", event));
        socket.addEventListener("close", () => this.onClose(socket));
        this.finishHandshake().then(() => { settled = true; resolve(); }).catch((error) => { socket.close(1002, "handshake failed"); fail(error instanceof Error ? error : new Error(String(error))); });
      });
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    bridge: ReturnType<typeof createClientBridge>,
    event: MessageEvent,
  ): Promise<void> {
    if (this.socket !== socket) return;
    const received = event.data;
    const data: string | ArrayBuffer | ArrayBufferView = received instanceof Blob
      ? new Uint8Array(await received.arrayBuffer())
      : received as string | ArrayBuffer | ArrayBufferView;
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data).byteLength
      : data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    if (bytes > this.options.maxFrameBytes) { socket.close(1009, "RPC frame too large"); return; }
    if (hasRpcPrefix(data, MANAGER_TO_PLUGIN_PREFIX)) {
      bridge.dispatch("message", { data });
      return;
    }
    if (!hasRpcPrefix(data, PLUGIN_TO_MANAGER_PREFIX)) {
      socket.close(1002, "invalid RPC prefix");
      return;
    }
    try {
      await this.reverseHandler?.message(
        bridge,
        data as string | ArrayBuffer | Pick<Uint8Array<ArrayBuffer>, "buffer" | "byteLength" | "byteOffset">,
        { context: { signal: AbortSignal.timeout(10_000) } },
      );
    } catch {
      socket.close(1002, "invalid reverse RPC frame");
    }
  }

  private async finishHandshake(): Promise<void> {
    if (!this.forward) throw new PluginConnectionError("RPC client unavailable");
    const result = await this.forward.system.handshake({ rpcProtocolVersion: RPC_VERSION, pluginApiVersion: 1, pluginId: this.options.pluginId }, { signal: AbortSignal.timeout(10_000) });
    if (result.pluginId !== this.options.pluginId || result.rpcProtocolVersion !== RPC_VERSION || result.pluginApiVersion !== 1) throw new PluginConnectionError("plugin handshake identity mismatch");
    this.manifestInfo = result;
    this.handshaken = true;
    this.heartbeatTimer = setInterval(() => this.ping(), this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async request(method: "plugin.handleEvent" | "action.encode" | "ui.render" | "ui.handleAction", input: unknown, timeoutMs: number): Promise<unknown> {
    await this.connect();
    if (!this.forward || !this.socket) throw new PluginConnectionError("plugin is unavailable");
    if (this.socket.bufferedAmount > this.options.backpressureBytes) throw new PluginConnectionError("plugin send queue is full");
    if (this.pending >= this.options.maxPendingRequests) throw new PluginConnectionError("plugin request limit reached");
    this.pending += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const operation = input as Record<string, unknown>;
      if (method === "plugin.handleEvent") return await this.forward.plugin.handleEvent({ ...operation, deadlineMs: timeoutMs }, { signal: controller.signal });
      if (method === "action.encode") return await this.forward.action.encode({ ...operation, deadlineMs: timeoutMs }, { signal: controller.signal });
      if (method === "ui.render") return await this.forward.ui.render({ ...operation, deadlineMs: timeoutMs }, { signal: controller.signal });
      return await this.forward.ui.handleAction({ ...operation, deadlineMs: timeoutMs }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new PluginConnectionTimeout(`${method} timed out`);
      throw error;
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  private async ping(): Promise<void> {
    if (!this.forward || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.heartbeatTimeoutMs);
    try { await this.forward.system.ping({ nonce: crypto.randomUUID() }, { signal: controller.signal }); } catch { this.socket.close(1011, "heartbeat timeout"); } finally { clearTimeout(timer); }
  }

  private onClose(socket: WebSocket | null = this.socket): void {
    if (socket && socket !== this.socket) return;
    const connectionId = this.connectionId;
    const reverseHandler = this.reverseHandler;
    const bridge = this.bridge;
    bridge?.notifyClose();
    this.handshaken = false; this.forward = null; this.manifestInfo = null; this.bridge = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
    this.reverseHandler = null; this.socket = null;
    this.connectionId = crypto.randomUUID();
    if (reverseHandler && bridge) void reverseHandler.close(bridge);
    this.options.onDisconnect?.(connectionId);
  }

  disconnect(reason = "connection reset"): void {
    const socket = this.socket;
    if (socket) {
      try { socket.close(1012, reason); } catch { /* already closed */ }
      this.onClose(socket);
    }
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    if (socket) {
      try { socket.close(1000, "manager shutdown"); } catch { /* already closed */ }
      this.onClose(socket);
    }
  }
}

function createClientBridge(socket: WebSocket, backpressureBytes: number) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let closed = false;
  const dispatch = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    get readyState() { return closed ? WebSocket.CLOSED : socket.readyState; },
    send(data: string | Uint8Array<ArrayBuffer>) {
      if (socket.bufferedAmount > backpressureBytes) throw new PluginConnectionError("plugin send queue is full");
      return socket.send(data);
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, set = new Set());
      set.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener); },
    dispatch,
    notifyClose() {
      if (closed) return;
      closed = true;
      dispatch("close", {});
      listeners.clear();
    },
    close() { socket.close(); },
  };
}
