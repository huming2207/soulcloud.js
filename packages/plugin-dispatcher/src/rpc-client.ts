/**
 * Dispatcher-side HTTP MessagePack-RPC client.
 *
 * Plugin Hosts are independent containers. Docker/Kubernetes owns their
 * process lifecycle; this client only owns request deadlines, response size
 * limits and connection health. A timeout never attempts to signal a remote
 * container.
 */

import { RPCLink } from "@orpc/client/websocket";
import { createContractClientFactory } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import {
  PLUGIN_RPC_D2H_PREFIX,
  PLUGIN_RPC_H2D_PREFIX,
  PLUGIN_RPC_PROTOCOL_HEADER,
  matchesRpcPrefix,
  dispatcherToHostContract,
  hostToDispatcherContract,
  type CommandEnqueueInput,
  type EncodeActionInput,
  type EntityGetInput,
  type EntityGetOutput,
  type HandleEventInput,
} from "@soulcloud/plugin-rpc-contract";
import {
  DEFAULT_MAX_FRAME_BYTES,
  HANDSHAKE_METHOD,
  RPC_CONTENT_TYPE,
  RPC_VERSION,
  decodeRpcMessage,
  encodeRpcMessage,
  isRpcResponse,
  type RpcError,
  type RpcResponse,
} from "@soulcloud/plugin-sdk";

export interface PluginHostReverseHandlers {
  entityGet(input: EntityGetInput, signal: AbortSignal, connectionId?: string): Promise<EntityGetOutput>;
  commandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId?: string): Promise<{ ok: true }>;
}

export interface PluginHostClientOptions {
  baseUrl: string;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  authToken?: string;
  reverseHandlers?: PluginHostReverseHandlers;
  backpressureBytes?: number;
  maxPendingRequests?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface PluginHostClientLike {
  readonly isOpen: boolean;
  readonly connectionId?: string;
  request(method: string, params: unknown, deadlineMs: number): Promise<unknown>;
  handshake(expected: { pluginId: string; pluginVersion: string; apiVersion: number }): Promise<void>;
  close(): void;
}

export class PluginHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginHostUnavailableError";
  }
}

export class PluginHostTimeoutError extends Error {
  constructor(
    public readonly method: string,
    deadlineMs: number,
  ) {
    super(`plugin host did not answer "${method}" within ${deadlineMs}ms`);
    this.name = "PluginHostTimeoutError";
  }
}

export class PluginHostClient {
  private readonly baseUrl: string;
  private readonly maxFrameBytes: number;
  private readonly handshakeTimeoutMs: number;
  private readonly authToken?: string;
  private closed = false;
  private nextId = 1;

  private constructor(options: PluginHostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.authToken = options.authToken;
    try {
      const url = new URL(this.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported protocol ${url.protocol}`);
      }
    } catch (error) {
      throw new PluginHostUnavailableError(
        `invalid plugin host URL: ${(error as Error).message}`,
      );
    }
  }

  static async connect(
    options: PluginHostClientOptions,
  ): Promise<PluginHostClientLike> {
    if (options.baseUrl.startsWith("ws://") || options.baseUrl.startsWith("wss://")) {
      return PluginHostWsClient.connect(options);
    }
    const client = new PluginHostClient(options);
    // Connecting is deliberately lazy; handshake performs the first health
    // request and is supervised by the caller's retry/circuit policy.
    return client;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  async request(
    method: string,
    params: unknown,
    deadlineMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      throw new PluginHostUnavailableError("plugin host client is closed");
    }
    const id = this.nextId++;
    const message = { version: RPC_VERSION, id, method, params, deadlineMs };
    let encodedMessage: Uint8Array;
    try {
      encodedMessage = encodeRpcMessage(message, this.maxFrameBytes);
    } catch (error) {
      throw new PluginHostUnavailableError((error as Error).message);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": RPC_CONTENT_TYPE,
        accept: RPC_CONTENT_TYPE,
      };
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
      response = await fetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers,
        body: encodedMessage,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PluginHostTimeoutError(method, deadlineMs);
      }
      throw new PluginHostUnavailableError((error as Error).message);
    }
    try {
      if (!response.ok) {
        throw new PluginHostUnavailableError(
          `plugin host returned HTTP ${response.status}`,
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > this.maxFrameBytes) {
        throw new PluginHostUnavailableError("plugin host response exceeds size ceiling");
      }
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > this.maxFrameBytes) {
        throw new PluginHostUnavailableError("plugin host response exceeds size ceiling");
      }
      let messageResponse: RpcResponse;
      try {
        const decoded = decodeRpcMessage(body, this.maxFrameBytes);
        if (!isRpcResponse(decoded)) {
          throw new Error("not a valid MessagePack-RPC response");
        }
        messageResponse = decoded;
      } catch {
        throw new PluginHostUnavailableError(
          "plugin host returned invalid MessagePack-RPC",
        );
      }
      if (
        messageResponse.id !== id ||
        typeof messageResponse.ok !== "boolean" ||
        (!messageResponse.ok &&
          (!messageResponse.error ||
            typeof messageResponse.error.code !== "string" ||
            typeof messageResponse.error.message !== "string"))
      ) {
        throw new PluginHostUnavailableError(
          "plugin host returned an invalid MessagePack-RPC response",
        );
      }
      if (messageResponse.ok) return messageResponse.result;
      const error = new Error(
        `${messageResponse.error.code}: ${messageResponse.error.message}`,
      ) as Error & { code?: RpcError["code"] };
      error.code = messageResponse.error.code;
      throw error;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PluginHostTimeoutError(method, deadlineMs);
      }
      if (error instanceof PluginHostTimeoutError || error instanceof PluginHostUnavailableError) {
        throw error;
      }
      if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string") {
        // Preserve MessagePack-RPC application error codes for the dispatcher
        // (invalid_params/overloaded/response_too_large are policy signals,
        // not transport failures).
        throw error;
      }
      throw new PluginHostUnavailableError((error as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  async handshake(expected: {
    pluginId: string;
    pluginVersion: string;
    apiVersion: number;
  }): Promise<void> {
    const result = (await this.request(
      HANDSHAKE_METHOD,
      { rpcVersion: RPC_VERSION },
      this.handshakeTimeoutMs,
    )) as {
      rpcVersion: number;
      pluginId: string;
      pluginVersion: string;
      apiVersion: number;
    };
    if (
      result.rpcVersion !== RPC_VERSION ||
      result.pluginId !== expected.pluginId ||
      result.pluginVersion !== expected.pluginVersion ||
      result.apiVersion !== expected.apiVersion
    ) {
      throw new PluginHostUnavailableError(
        `handshake mismatch: got ${result.pluginId}@${result.pluginVersion} ` +
          `(rpc ${result.rpcVersion}, api ${result.apiVersion}), expected ` +
          `${expected.pluginId}@${expected.pluginVersion} (rpc ${RPC_VERSION}, api ${expected.apiVersion})`,
      );
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** oRPC v2 client for the one-socket, two-prefix transport. */
class PluginHostWsClient implements PluginHostClientLike {
  private readonly wsUrl: string;
  private readonly maxFrameBytes: number;
  private currentConnectionId: string | undefined;
  private readonly handshakeTimeoutMs: number;
  private readonly authToken?: string;
  private readonly reverseHandlers?: PluginHostReverseHandlers;
  private readonly backpressureBytes: number;
  private readonly maxPendingRequests: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private socket: WebSocket | null = null;
  private d2hClient: any = null;
  private h2dHandler: RPCHandler<any> | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private pendingRequests = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(options: PluginHostClientOptions) {
    this.wsUrl = options.baseUrl.replace(/\/$/, "");
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.authToken = options.authToken;
    this.reverseHandlers = options.reverseHandlers;
    this.backpressureBytes = options.backpressureBytes ?? 4 * 1024 * 1024;
    this.maxPendingRequests = options.maxPendingRequests ?? 128;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 3_000;
    try {
      const url = new URL(this.wsUrl);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`unsupported protocol ${url.protocol}`);
    } catch (error) {
      throw new PluginHostUnavailableError(`invalid plugin host WebSocket URL: ${(error as Error).message}`);
    }
  }

  static async connect(options: PluginHostClientOptions): Promise<PluginHostWsClient> {
    return new PluginHostWsClient(options);
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  get connectionId(): string | undefined {
    return this.currentConnectionId;
  }

  private async ensureConnected(): Promise<void> {
    if (this.isOpen) return;
    if (this.closed) throw new PluginHostUnavailableError("plugin host client is closed");
    if (this.connecting) return this.connecting;
    let rejectConnection: ((reason?: unknown) => void) | null = null;
    this.connecting = new Promise<void>((resolve, reject) => {
      rejectConnection = reject;
      const socket = new WebSocket(this.wsUrl, {
        headers: {
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          "x-soulcloud-rpc-protocol": PLUGIN_RPC_PROTOCOL_HEADER,
        },
      });
      const connectionId = crypto.randomUUID();
      this.currentConnectionId = connectionId;
      this.socket = socket;
      const fail = (error: Error) => {
        if (this.connecting) {
          this.connecting = null;
          reject(new PluginHostUnavailableError(error.message));
        }
      };
      socket.addEventListener("open", () => {
        const bridge = socket;
        const reverse = this.reverseHandlers;
        const implemented = implement(hostToDispatcherContract).$context<object>();
        const reverseCall = async <T>(
          call: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          try {
            return await call(AbortSignal.timeout(10_000));
          } catch (error) {
            const code = (error as Error & { code?: string }).code;
            if (code === "overloaded") {
              throw new ORPCError("CALLBACK_OVERLOADED" as never, { message: (error as Error).message });
            }
            if (code === "invalid_plugin_output") {
              throw new ORPCError("INVALID_PLUGIN_OUTPUT" as never, { message: (error as Error).message });
            }
            throw error;
          }
        };
        const router = {
          system: {
            ping: implemented.system.ping.handler(({ input }) => input),
          },
          context: {
            entities: {
              get: implemented.context.entities.get.handler(({ input }) => {
                if (!reverse) throw new Error("reverse entity reads are not configured");
                return reverseCall((signal) => reverse.entityGet(input, signal, connectionId));
              }),
            },
            commands: {
              enqueue: implemented.context.commands.enqueue.handler(({ input }) => {
                if (!reverse) throw new Error("reverse command enqueue is not configured");
                return reverseCall((signal) => reverse.commandEnqueue(input, signal, connectionId));
              }),
            },
          },
        };
        this.h2dHandler = new RPCHandler(router, {
          encodePeerMessage: { prefix: PLUGIN_RPC_H2D_PREFIX },
          decodePeerMessage: { prefix: PLUGIN_RPC_H2D_PREFIX },
        });
        socket.addEventListener("message", (event) => {
          const data = event.data as unknown;
          const frameBytes = typeof data === "string"
            ? Buffer.byteLength(data, "utf8")
            : data instanceof Blob
              ? data.size
              : data instanceof ArrayBuffer
                ? data.byteLength
                : ArrayBuffer.isView(data)
                  ? data.byteLength
                  : Number.POSITIVE_INFINITY;
          if (frameBytes > this.maxFrameBytes) {
            socket.close(1009, "RPC frame too large");
            return;
          }
          if (!(typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
            socket.close(1002, "unknown RPC prefix");
            return;
          }
          const prefixData = (typeof data === "string" || data instanceof ArrayBuffer
            ? data
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)) as
            | string
            | ArrayBuffer
            | Pick<Uint8Array<ArrayBuffer>, "buffer" | "byteLength" | "byteOffset">;
          if (!matchesRpcPrefix(prefixData, PLUGIN_RPC_D2H_PREFIX) && !matchesRpcPrefix(prefixData, PLUGIN_RPC_H2D_PREFIX)) {
            socket.close(1002, "unknown RPC prefix");
            return;
          }
          if (!matchesRpcPrefix(prefixData, PLUGIN_RPC_H2D_PREFIX)) return;
          void this.h2dHandler?.message(bridge, prefixData, { context: {} });
        });
        const link = new RPCLink({
          connect: () => socket,
          encodePeerMessage: { prefix: PLUGIN_RPC_D2H_PREFIX },
          decodePeerMessage: { prefix: PLUGIN_RPC_D2H_PREFIX },
        });
        this.d2hClient = createContractClientFactory(link)(dispatcherToHostContract);
        this.heartbeatTimer = setInterval(() => {
          const activeSocket = this.socket;
          if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !this.d2hClient) return;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.heartbeatTimeoutMs);
          void this.d2hClient.system.ping({ nonce: crypto.randomUUID() }, { signal: controller.signal })
            .catch(() => activeSocket.close(1011, "heartbeat timeout"))
            .finally(() => clearTimeout(timer));
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
        this.connecting = null;
        resolve();
      });
      socket.addEventListener("error", () => fail(new Error("plugin host WebSocket connection failed")));
      socket.addEventListener("close", () => {
        if (this.connecting && rejectConnection) {
          this.connecting = null;
          rejectConnection(new PluginHostUnavailableError("plugin host WebSocket closed during connect"));
          rejectConnection = null;
        }
        this.socket = null;
        if (this.currentConnectionId === connectionId) this.currentConnectionId = undefined;
        this.d2hClient = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        void this.h2dHandler?.close(socket);
        this.h2dHandler = null;
      });
    });
    return this.connecting;
  }

  async request(method: string, params: unknown, deadlineMs: number): Promise<unknown> {
    await this.ensureConnected();
    const client = this.d2hClient;
    if (!client) throw new PluginHostUnavailableError("plugin host WebSocket is not ready");
    if (this.socket && this.socket.bufferedAmount > this.backpressureBytes) {
      const error = new PluginHostUnavailableError("plugin host WebSocket send queue is full") as Error & { code?: string };
      error.code = "overloaded";
      throw error;
    }
    if (this.pendingRequests >= this.maxPendingRequests) {
      const error = new PluginHostUnavailableError("plugin host WebSocket request limit reached") as Error & { code?: string };
      error.code = "overloaded";
      throw error;
    }
    this.pendingRequests += 1;
    const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const operation = {
      operationId: typeof input.operationId === "string" ? input.operationId : crypto.randomUUID(),
      operationToken: typeof input.operationToken === "string" ? input.operationToken : crypto.randomUUID().replaceAll("-", ""),
      deadlineMs,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      if (method === "host.handshake") {
        return await client.system.handshake(input, { signal: controller.signal });
      }
      if (method === "plugin.handleEvent") {
        return await client.plugin.handleEvent({ ...input, ...operation }, { signal: controller.signal });
      }
      if (method === "action.encode") {
        const result = await client.action.encode({ ...input, ...operation }, { signal: controller.signal }) as {
          cmd: string;
          args: Array<{ name: string; value: unknown }>;
          schemaVersion: number;
        };
        const args = [] as Array<{ name: string; value: unknown }>;
        for (const arg of result.args) {
          args.push({
            name: arg.name,
            value: arg.value instanceof Blob
              ? new Uint8Array(await arg.value.arrayBuffer())
              : arg.value,
          });
        }
        return { ...result, args };
      }
      if (method === "system.ping") {
        return await client.system.ping(input, { signal: controller.signal });
      }
      throw new PluginHostUnavailableError(`unknown oRPC method ${method}`);
    } catch (error) {
      if (controller.signal.aborted) throw new PluginHostTimeoutError(method, deadlineMs);
      const message = (error as Error).message;
      const coded = error as Error & { code?: string };
      const prefix = message.match(/^([a-z_]+):\s*(.*)$/i);
      if (prefix) coded.code = prefix[1];
      if (coded.code) {
        const codeMap: Record<string, string> = {
          INVALID_ACTION_INPUT: "invalid_params",
          INVALID_ACTION_OUTPUT: "invalid_action_output",
          INVALID_PLUGIN_OUTPUT: "invalid_params",
          INVALID_EVENT_INPUT: "invalid_params",
          CALLBACK_OVERLOADED: "callback_overloaded",
          OVERLOADED: "overloaded",
          HANDLER_ERROR: "handler_error",
          INTERNAL_SERVER_ERROR: "handler_error",
        };
        coded.code = codeMap[coded.code] ?? codeMap[coded.code.toUpperCase()] ?? coded.code.toLowerCase();
      }
      if (coded.code) throw coded;
      throw new PluginHostUnavailableError(message);
    } finally {
      clearTimeout(timer);
      this.pendingRequests -= 1;
    }
  }

  async handshake(expected: { pluginId: string; pluginVersion: string; apiVersion: number }): Promise<void> {
    const result = await this.request("host.handshake", {
      rpcVersion: RPC_VERSION,
      pluginId: expected.pluginId,
      pluginVersion: expected.pluginVersion,
      apiVersion: expected.apiVersion,
    }, this.handshakeTimeoutMs) as {
      rpcVersion: number;
      pluginId: string;
      pluginVersion: string;
      apiVersion: number;
    };
    if (result.rpcVersion !== RPC_VERSION || result.pluginId !== expected.pluginId || result.pluginVersion !== expected.pluginVersion || result.apiVersion !== expected.apiVersion) {
      throw new PluginHostUnavailableError(`handshake mismatch: got ${result.pluginId}@${result.pluginVersion} (rpc ${result.rpcVersion}, api ${result.apiVersion})`);
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.socket?.close(1000, "client closed");
    this.socket = null;
    this.d2hClient = null;
  }
}
