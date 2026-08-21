/** Dispatcher <-> Plugin Host MessagePack-RPC message contract. */

import {
  decodeMulti as decodeMessagePackMulti,
  encode as encodeMessagePack,
} from "@msgpack/msgpack";

import type { CommandArgument, EntityUpdate } from "./types";

export const RPC_VERSION = 2;
/** HTTP media type used by the internal RPC endpoints. */
export const RPC_CONTENT_TYPE = "application/msgpack";
/** Maximum encoded request/response body used by RPC implementations. */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

/** Error raised when a MessagePack RPC frame is malformed or too large. */
export class RpcCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcCodecError";
  }
}

/**
 * Encodes exactly one RPC value. `useBigInt64` and native MessagePack binary
 * preserve command arguments that ordinary JSON cannot represent.
 */
export function encodeRpcMessage(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  let encoded: Uint8Array;
  try {
    encoded = encodeMessagePack(value, {
      useBigInt64: true,
      maxDepth: 64,
    });
  } catch (error) {
    throw new RpcCodecError(
      `cannot encode RPC MessagePack frame: ${(error as Error).message}`,
    );
  }
  if (encoded.byteLength > maxFrameBytes) {
    throw new RpcCodecError(
      `RPC MessagePack frame exceeds ${maxFrameBytes} bytes`,
    );
  }
  return encoded;
}

/**
 * Decodes exactly one RPC value. `decodeMulti` is intentional: unlike the
 * single-value decoder it lets us reject trailing MessagePack values rather
 * than silently accepting a concatenated frame.
 */
export function decodeRpcMessage(
  payload: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): unknown {
  if (payload.byteLength === 0) {
    throw new RpcCodecError("RPC MessagePack frame is empty");
  }
  if (payload.byteLength > maxFrameBytes) {
    throw new RpcCodecError(
      `RPC MessagePack frame exceeds ${maxFrameBytes} bytes`,
    );
  }
  try {
    const values = decodeMessagePackMulti(payload, {
      useBigInt64: true,
      maxStrLength: maxFrameBytes,
      maxBinLength: maxFrameBytes,
      maxArrayLength: 4096,
      maxMapLength: 4096,
      maxExtLength: maxFrameBytes,
    });
    const first = values.next();
    if (first.done) {
      throw new RpcCodecError("RPC MessagePack frame is empty");
    }
    const trailing = values.next();
    if (!trailing.done) {
      throw new RpcCodecError(
        "RPC MessagePack frame contains trailing values",
      );
    }
    return first.value;
  } catch (error) {
    if (error instanceof RpcCodecError) throw error;
    throw new RpcCodecError(
      `cannot decode RPC MessagePack frame: ${(error as Error).message}`,
    );
  }
}

export interface RpcRequest {
  version: number;
  id: number;
  method: string;
  params?: unknown;
  /** Milliseconds the caller is willing to wait (advisory to the host). */
  deadlineMs: number;
}

export type RpcErrorCode =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "deadline_exceeded"
  | "response_too_large"
  | "handler_error"
  | "overloaded"
  | "internal_error"
  | "unauthorized"
  | "unknown_action"
  | "invalid_action_input"
  | "invalid_action_output"
  | "plugin_unavailable"
  | "encode_timeout";

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { version: number; id: number; ok: true; result: unknown }
  | { version: number; id: number; ok: false; error: RpcError };

export interface RpcNotification {
  version: number;
  notification: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export function isRpcRequest(message: unknown): message is RpcRequest {
  if (!message || typeof message !== "object") return false;
  const request = message as Partial<RpcRequest>;
  return (
    request.version === RPC_VERSION &&
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

export function isRpcResponse(message: unknown): message is RpcResponse {
  if (!message || typeof message !== "object") return false;
  const response = message as Partial<RpcResponse>;
  return (
    response.version === RPC_VERSION &&
    typeof response.id === "number" &&
    typeof response.ok === "boolean"
  );
}

export const HANDSHAKE_METHOD = "host.handshake";
export const HANDLE_EVENT_METHOD = "plugin.handleEvent";
/**
 * Synchronous action-input encoding (§5, stage 3). The encoder is plugin
 * code, so it executes in the HOST process only — the API/dispatcher never
 * run it inline (review fix: container isolation for action encoding).
 */
export const ENCODE_ACTION_METHOD = "action.encode";

export interface HandshakeRequest {
  rpcVersion: number;
}

export interface HandshakeResult {
  rpcVersion: number;
  pluginId: string;
  pluginVersion: string;
  apiVersion: number;
}

export interface HandleEventParams {
  eventId: string;
  eventKind: string;
  schemaVersion: number;
  payload: unknown;
  device: {
    id: string;
    deviceUid: string;
    profileId: string;
    profileVersion: number;
  };
  installation: {
    id: string;
    projectId: string;
    config: unknown;
  };
  receivedAt: string;
}

export interface HandleEventResult {
  updates: EntityUpdate[];
}

export interface EncodeActionParams {
  actionId: string;
  /** User-supplied action input, validated against the declared schema. */
  input: unknown;
}

export interface EncodeActionResult {
  /** DeviceCommand wire name declared by the action. */
  cmd: string;
  /** Encoded single-key arguments (validated single-key scalar maps). */
  args: CommandArgument[];
  /** Declared wire schema version (metadata). */
  schemaVersion: number;
}

export const LOG_NOTIFICATION = "log";

export interface LogNotificationParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  pluginId: string;
  installationId: string;
  projectId: string;
  operationId: string;
}
