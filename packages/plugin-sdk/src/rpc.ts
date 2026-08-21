/** Dispatcher <-> Plugin Host JSON-RPC message contract. */

import type { EntityUpdate } from "./types";

export const RPC_VERSION = 1;
/** Maximum serialized request/response body used by HTTP implementations. */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface RpcRequest {
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
  | "internal_error";

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: RpcError };

export interface RpcNotification {
  notification: string;
  params?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export function isRpcRequest(message: unknown): message is RpcRequest {
  if (!message || typeof message !== "object") return false;
  const request = message as Partial<RpcRequest>;
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

export function isRpcResponse(message: unknown): message is RpcResponse {
  if (!message || typeof message !== "object") return false;
  const response = message as Partial<RpcResponse>;
  return typeof response.id === "number" && typeof response.ok === "boolean";
}

export const HANDSHAKE_METHOD = "host.handshake";
export const HANDLE_EVENT_METHOD = "plugin.handleEvent";

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
