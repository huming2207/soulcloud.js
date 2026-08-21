/**
 * Dispatcher-side HTTP MessagePack-RPC client.
 *
 * Plugin Hosts are independent containers. Docker/Kubernetes owns their
 * process lifecycle; this client only owns request deadlines, response size
 * limits and connection health. A timeout never attempts to signal a remote
 * container.
 */

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

export interface PluginHostClientOptions {
  baseUrl: string;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  authToken?: string;
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
  ): Promise<PluginHostClient> {
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
