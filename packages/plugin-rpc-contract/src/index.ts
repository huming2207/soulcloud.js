import { meta, oc } from "@orpc/contract";
import { z } from "zod";

export const RPC_VERSION = 1 as const;
export const PLUGIN_API_VERSION = 1 as const;
export const MANAGER_TO_PLUGIN_PREFIX = "soulcloud:m2p:v1:";
export const PLUGIN_TO_MANAGER_PREFIX = "soulcloud:p2m:v1:";
export const RPC_PATH = "/rpc/ws";
export const RPC_PROTOCOL_HEADER = "1";

const encoder = new TextEncoder();
const prefixBytes = new Map([
  [MANAGER_TO_PLUGIN_PREFIX, encoder.encode(MANAGER_TO_PLUGIN_PREFIX)],
  [PLUGIN_TO_MANAGER_PREFIX, encoder.encode(PLUGIN_TO_MANAGER_PREFIX)],
]);

export function hasRpcPrefix(data: string | ArrayBuffer | ArrayBufferView, prefix: string): boolean {
  if (typeof data === "string") return data.startsWith(prefix);
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const expected = prefixBytes.get(prefix) ?? encoder.encode(prefix);
  if (bytes.byteLength < expected.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) if (bytes[index] !== expected[index]) return false;
  return true;
}

const scalar = z.union([z.string(), z.number().finite(), z.bigint(), z.boolean(), z.null(), z.instanceof(Blob)]);
const entityValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.instanceof(Blob)]);
const entityUpdateValue = z.union([z.string(), z.number().finite(), z.boolean(), z.instanceof(Blob)]);
const uint64 = z.union([z.bigint(), z.number().safe().int()]).refine((value) => {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  return bigint >= 0n && bigint <= (1n << 64n) - 1n;
}, "expected an unsigned 64-bit integer");
const operation = z.object({ operationId: z.string().min(16).max(128), operationToken: z.string().min(32).max(256), deadlineMs: z.number().int().positive().max(600_000) });
const commandArgument = z.object({ name: z.string().min(1).max(256), value: scalar }).strict();
const uiUser = z.object({ id: z.string().min(1).max(128), locale: z.string().min(2).max(32), permissions: z.array(z.string().min(1).max(128)).max(256) }).strict();

export const handshakeInput = z.object({
  rpcProtocolVersion: z.literal(RPC_VERSION),
  pluginApiVersion: z.literal(PLUGIN_API_VERSION),
  pluginId: z.string().min(1).max(128),
}).strict();
export const handshakeOutput = z.object({
  rpcProtocolVersion: z.literal(RPC_VERSION),
  pluginApiVersion: z.literal(PLUGIN_API_VERSION),
  pluginId: z.string().min(1).max(128),
  pluginVersion: z.string().min(1).max(128),
  manifest: z.unknown(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.object({ reverseRpcVersion: z.literal(1), blob: z.boolean(), ssr: z.literal(false).or(z.object({ version: z.literal(1), streaming: z.boolean() })) }).strict(),
}).strict();

export const eventInput = operation.extend({
  event: z.object({ id: z.string().min(1).max(128), seq: uint64, kind: z.string().min(1).max(256), schema: z.number().int().positive(), receivedAt: z.string().datetime({ offset: true }), payload: z.unknown() }).strict(),
  installation: z.object({ id: z.string().min(1).max(128), projectId: z.string().uuid(), pluginId: z.string().min(1).max(128), pluginVersion: z.string().min(1).max(128), config: z.unknown() }).strict(),
  device: z.object({ id: z.string().uuid(), uid: z.string().min(1).max(256), profileId: z.string().min(1).max(128), profileVersion: z.number().int().positive() }).strict(),
  execution: z.object({ executionId: z.string().uuid(), executionToken: z.string().min(32).max(256) }).strict().optional(),
}).strict();

export const eventOutput = z.object({
  updates: z.array(z.object({ entityKey: z.string().min(1).max(128), value: entityUpdateValue.optional(), quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]).optional(), sourceTimestamp: z.string().datetime({ offset: true }).optional(), sequence: uint64.optional(), alarm: z.object({ level: z.enum(["info", "warning", "critical"]), code: z.string().min(1).max(256) }).strict().nullable().optional() }).strict()).max(4096).default([]),
  logs: z.array(z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string().min(1).max(4096) }).strict()).max(64).default([]),
}).strict();

export const actionInput = operation.extend({ actionId: z.string().min(1).max(128), installationId: z.string().uuid(), projectId: z.string().uuid(), deviceId: z.string().uuid(), userId: z.string().uuid(), input: z.unknown() }).strict();
export const actionOutput = z.object({ command: z.string().min(1).max(256), args: z.array(commandArgument).max(256), schemaVersion: z.number().int().positive() }).strict();

export const uiRenderInput = operation.extend({ requestId: z.string().min(1).max(128), routeId: z.string().min(1).max(128), installationId: z.string().uuid(), projectId: z.string().uuid(), user: uiUser, params: z.record(z.string().max(128), z.union([z.string().max(1024), z.number().finite(), z.boolean()])).refine((value) => Object.keys(value).length <= 32) }).strict();
export const uiRenderOutput = z.object({ html: z.string().max(2 * 1024 * 1024), title: z.string().max(256).optional(), status: z.number().int().min(200).max(599).refine((status) => status < 300 || status >= 400, "redirect status is not allowed").refine((status) => status !== 204 && status !== 205, "bodyless status is not allowed").optional(), cache: z.literal("no-store").or(z.object({ maxAgeSeconds: z.number().int().nonnegative().max(86_400) })).optional() }).strict();
export const uiActionInput = uiRenderInput.extend({ action: z.unknown() }).strict();
export const uiActionOutput = z.object({ redirect: z.string().max(2048).optional(), errors: z.array(z.object({ field: z.string().max(128), message: z.string().max(2048) }).strict()).max(64).optional() }).strict();
export const uiAssetInput = operation.extend({ requestId: z.string().min(1).max(128), assetPath: z.string().regex(/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/).max(256), routeId: z.string().min(1).max(128), installationId: z.string().uuid(), projectId: z.string().uuid(), user: uiUser }).strict();
export const uiAssetOutput = z.object({ body: z.instanceof(Blob).refine((value) => value.size > 0 && value.size <= 256 * 1024, "UI asset is empty or too large"), contentType: z.string().min(1).max(128).refine((value) => !/[\r\n]/.test(value), "invalid content type"), cache: z.literal("no-store").or(z.object({ maxAgeSeconds: z.number().int().nonnegative().max(86_400) })).optional() }).strict();
export const configureTargetInput = operation.extend({ installationId: z.string().uuid(), projectId: z.string().uuid(), userId: z.string().uuid(), yaml: z.string().min(1).max(65_536) }).strict();
export const configureTargetOutput = z.object({ configId: z.string().uuid(), revision: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), targetCount: z.number().int().positive().max(64) }).strict();
export const listTargetConfigsInput = operation.extend({ installationId: z.string().uuid(), projectId: z.string().uuid(), userId: z.string().uuid() }).strict();
export const listTargetConfigsOutput = z.array(z.object({ configId: z.string().uuid(), revision: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), targetCount: z.number().int().positive().max(64), createdAt: z.string().datetime({ offset: true }) }).strict()).max(64);
export const artifactChunkInput = operation.extend({ installationId: z.string().uuid(), projectId: z.string().uuid(), userId: z.string().uuid(), uploadId: z.string().uuid(), kind: z.enum(["elf", "firmware"]), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), contentType: z.string().min(1).max(128), totalSize: z.number().int().positive().max(64 * 1024 * 1024), offset: z.number().int().nonnegative().max(64 * 1024 * 1024), final: z.boolean(), chunk: z.instanceof(Blob).refine((value) => value.size > 0 && value.size <= 64 * 1024, "artifact chunk must be 1..65536 bytes") }).strict()
  .refine((value) => value.offset + value.chunk.size <= value.totalSize, "artifact chunk exceeds the declared size")
  .refine((value) => value.final ? value.offset + value.chunk.size === value.totalSize : value.offset + value.chunk.size < value.totalSize, "final artifact chunk must end at the declared size");
export const artifactChunkOutput = z.object({ uploadId: z.string().uuid(), receivedBytes: z.number().int().positive().max(64 * 1024 * 1024), complete: z.boolean(), artifactId: z.string().uuid().nullable(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict();
export const listArtifactsInput = operation.extend({ installationId: z.string().uuid(), projectId: z.string().uuid(), userId: z.string().uuid() }).strict();
export const listArtifactsOutput = z.array(z.object({ artifactId: z.string().uuid(), kind: z.enum(["elf", "firmware"]), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), contentType: z.string().min(1).max(128), size: z.number().int().positive().max(64 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.string().datetime({ offset: true }) }).strict()).max(64);

export const entityGetInput = operation.extend({ entityKey: z.string().min(1).max(128) }).strict();
export const entityGetOutput = z.object({ entityKey: z.string(), value: entityValue, quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]), sourceTimestamp: z.string().datetime({ offset: true }).nullable(), ingestedAt: z.string().datetime({ offset: true }), alarm: z.object({ level: z.enum(["info", "warning", "critical"]), code: z.string() }).strict().nullable() }).strict().nullable();
export const commandEnqueueInput = operation.extend({ command: z.string().min(1).max(256), args: z.array(commandArgument).max(256) }).strict();
export const commandEnqueueOutput = z.object({ accepted: z.literal(true) }).strict();
export const pluginCallInput = operation.extend({ pluginId: z.string().min(1).max(128), procedure: z.string().min(1).max(256), input: z.unknown() }).strict();
export const pluginCallOutput = z.unknown();
export const pluginInvokeInput = operation.extend({
  caller: z.object({
    pluginId: z.string().min(1).max(128),
    pluginVersion: z.string().min(1).max(128),
    projectId: z.string().uuid(),
    installationId: z.string().uuid(),
    deviceId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
  }).strict(),
  procedure: z.string().min(1).max(256),
  input: z.unknown(),
}).strict();
export const uiDataInput = operation.extend({ key: z.string().min(1).max(128), input: z.unknown().optional() }).strict();
export const uiDataOutput = z.unknown();
export const pingInput = z.object({ nonce: z.string().min(1).max(128) }).strict();
export const pingOutput = pingInput;

const executionCapability = z.object({ executionId: z.string().uuid(), executionToken: z.string().min(32).max(256) }).strict();
const executionState = z.enum(["active", "paused", "cancelling", "completed", "failed", "expired"]);
export const executionOutput = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  initiatingUserId: z.string().uuid(),
  pluginId: z.string().min(1).max(128),
  pluginVersion: z.string().min(1).max(128),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  allowedCapabilities: z.array(z.string().min(1).max(128)).max(128),
  state: executionState,
  deviceLeaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const executionGetInput = operation.extend(executionCapability.shape).strict();
export const executionRenewLeaseInput = operation.extend({ ...executionCapability.shape, leaseMs: z.number().int().positive().max(900_000) }).strict();
export const executionReleaseInput = operation.extend(executionCapability.shape).strict();
export const executionCompleteInput = operation.extend({ ...executionCapability.shape, state: z.enum(["completed", "failed"]) }).strict();
const deviceCommandState = z.enum(["queued", "leased", "broker_accepted", "device_completed", "delivery_failed"]);
export const deviceCommandOutput = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  deviceId: z.string().uuid(),
  sequence: uint64,
  state: deviceCommandState,
  resultCode: z.number().int().nullable(),
  cancelRequestedAt: z.string().datetime({ offset: true }).nullable(),
  brokerAcceptedAt: z.string().datetime({ offset: true }).nullable(),
  deviceCompletedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const deviceEnqueueInput = operation.extend({ ...executionCapability.shape, command: z.string().min(1).max(256), args: z.array(commandArgument).max(256), idempotencyKey: z.string().min(1).max(128).optional() }).strict();
export const deviceGetInput = operation.extend({ ...executionCapability.shape, commandId: z.string().uuid() }).strict();
export const deviceCancelInput = operation.extend({ ...executionCapability.shape, commandId: z.string().uuid() }).strict();

const procedure = <Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(input: Input, output: Output, path: string[]) => oc.input(input).output(output).meta(meta.path(path));

export const managerToPluginContract = {
  system: {
    handshake: procedure(handshakeInput, handshakeOutput, ["system", "handshake"]),
    ping: procedure(pingInput, pingOutput, ["system", "ping"]),
  },
  plugin: {
    handleEvent: procedure(eventInput, eventOutput, ["plugin", "handleEvent"]),
    call: procedure(pluginInvokeInput, pluginCallOutput, ["plugin", "call"]),
  },
  action: { encode: procedure(actionInput, actionOutput, ["action", "encode"]) },
  ui: {
    render: procedure(uiRenderInput, uiRenderOutput, ["ui", "render"]),
    handleAction: procedure(uiActionInput, uiActionOutput, ["ui", "handleAction"]),
    asset: procedure(uiAssetInput, uiAssetOutput, ["ui", "asset"]),
  },
  debugger: {
    configureTarget: procedure(configureTargetInput, configureTargetOutput, ["debugger", "configureTarget"]),
    listTargetConfigs: procedure(listTargetConfigsInput, listTargetConfigsOutput, ["debugger", "listTargetConfigs"]),
    storeArtifactChunk: procedure(artifactChunkInput, artifactChunkOutput, ["debugger", "storeArtifactChunk"]),
    listArtifacts: procedure(listArtifactsInput, listArtifactsOutput, ["debugger", "listArtifacts"]),
  },
};

export const pluginToManagerContract = {
  system: { ping: procedure(pingInput, pingOutput, ["system", "ping"]) },
  context: {
    entities: { get: procedure(entityGetInput, entityGetOutput, ["context", "entities", "get"]) },
    commands: { enqueue: procedure(commandEnqueueInput, commandEnqueueOutput, ["context", "commands", "enqueue"]) },
    plugins: { callScoped: procedure(pluginCallInput, pluginCallOutput, ["context", "plugins", "callScoped"]) },
    ui: { getData: procedure(uiDataInput, uiDataOutput, ["context", "ui", "getData"]) },
    executions: {
      get: procedure(executionGetInput, executionOutput, ["context", "executions", "get"]),
      renewLease: procedure(executionRenewLeaseInput, executionOutput, ["context", "executions", "renewLease"]),
      release: procedure(executionReleaseInput, executionOutput, ["context", "executions", "release"]),
      complete: procedure(executionCompleteInput, executionOutput, ["context", "executions", "complete"]),
    },
    devices: {
      enqueueCommand: procedure(deviceEnqueueInput, deviceCommandOutput, ["context", "devices", "enqueueCommand"]),
      getCommand: procedure(deviceGetInput, deviceCommandOutput.nullable(), ["context", "devices", "getCommand"]),
      cancelCommand: procedure(deviceCancelInput, deviceCommandOutput, ["context", "devices", "cancelCommand"]),
    },
  },
};

export type ManagerToPluginContract = typeof managerToPluginContract;
export type PluginToManagerContract = typeof pluginToManagerContract;
export type HandshakeOutput = z.infer<typeof handshakeOutput>;
export type EventInput = z.infer<typeof eventInput>;
export type EventOutput = z.infer<typeof eventOutput>;
export type ExecutionOutput = z.infer<typeof executionOutput>;
export type ExecutionGetInput = z.infer<typeof executionGetInput>;
export type ExecutionRenewLeaseInput = z.infer<typeof executionRenewLeaseInput>;
export type ExecutionReleaseInput = z.infer<typeof executionReleaseInput>;
export type ExecutionCompleteInput = z.infer<typeof executionCompleteInput>;
export type DeviceEnqueueInput = z.infer<typeof deviceEnqueueInput>;
export type DeviceGetInput = z.infer<typeof deviceGetInput>;
export type DeviceCancelInput = z.infer<typeof deviceCancelInput>;
export type DeviceCommandOutput = z.infer<typeof deviceCommandOutput>;
export type ActionInput = z.infer<typeof actionInput>;
export type ActionOutput = z.infer<typeof actionOutput>;
export type UiRenderInput = z.infer<typeof uiRenderInput>;
export type UiRenderOutput = z.infer<typeof uiRenderOutput>;
export type UiActionOutput = z.infer<typeof uiActionOutput>;
export type UiAssetInput = z.infer<typeof uiAssetInput>;
export type UiAssetOutput = z.infer<typeof uiAssetOutput>;
export type ConfigureTargetInput = z.infer<typeof configureTargetInput>;
export type ConfigureTargetOutput = z.infer<typeof configureTargetOutput>;
export type ListTargetConfigsInput = z.infer<typeof listTargetConfigsInput>;
export type ListTargetConfigsOutput = z.infer<typeof listTargetConfigsOutput>;
export type ArtifactChunkInput = z.infer<typeof artifactChunkInput>;
export type ArtifactChunkOutput = z.infer<typeof artifactChunkOutput>;
export type ListArtifactsInput = z.infer<typeof listArtifactsInput>;
export type ListArtifactsOutput = z.infer<typeof listArtifactsOutput>;
export type UiDataInput = z.infer<typeof uiDataInput>;
export type EntityGetOutput = z.infer<typeof entityGetOutput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
export type CommandEnqueueInput = z.infer<typeof commandEnqueueInput>;
export type PluginCallInput = z.infer<typeof pluginCallInput>;
export type PluginInvokeInput = z.infer<typeof pluginInvokeInput>;

export interface RpcValueBudget { maxDepth: number; maxNodes: number; maxArrayItems: number; maxStringBytes: number; maxBlobs: number; maxBlobBytes: number; maxTotalBlobBytes: number }
export const DEFAULT_RPC_VALUE_BUDGET: Readonly<RpcValueBudget> = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxArrayItems: 4096,
  maxStringBytes: 65_536,
  maxBlobs: 16,
  maxBlobBytes: 65_536,
  maxTotalBlobBytes: 256 * 1024,
});
export function assertRpcValueBudget(value: unknown, budget: RpcValueBudget): void {
  const seen = new WeakSet<object>(); let nodes = 0; let totalBlobBytes = 0; let blobs = 0; let strings = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1; if (nodes > budget.maxNodes) throw new Error("RPC value node limit exceeded");
    if (depth > budget.maxDepth) throw new Error("RPC value depth limit exceeded");
    if (typeof current === "string") { strings += encoder.encode(current).byteLength; if (strings > budget.maxStringBytes) throw new Error("RPC string byte limit exceeded"); return; }
    if (current instanceof Blob) { blobs += 1; totalBlobBytes += current.size; if (blobs > budget.maxBlobs || current.size > budget.maxBlobBytes || totalBlobBytes > budget.maxTotalBlobBytes) throw new Error("RPC Blob limit exceeded"); return; }
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      const byteLength = current instanceof ArrayBuffer ? current.byteLength : current.byteLength;
      blobs += 1;
      totalBlobBytes += byteLength;
      if (blobs > budget.maxBlobs || byteLength > budget.maxBlobBytes || totalBlobBytes > budget.maxTotalBlobBytes) throw new Error("RPC binary limit exceeded");
      return;
    }
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) throw new Error("RPC cyclic value"); seen.add(current);
    if (Array.isArray(current)) { if (current.length > budget.maxArrayItems) throw new Error("RPC array item limit exceeded"); for (const value of current) visit(value, depth + 1); }
    else for (const value of Object.values(current)) visit(value, depth + 1);
    seen.delete(current);
  };
  visit(value, 0);
}

/**
 * RPC wire binary adapter. oRPC's JSON serializer keeps Blob values intact
 * but serializes Uint8Array/ArrayBuffer values as plain objects, so every
 * binary value crossing the WebSocket must be converted before sending.
 */
export function rpcBinaryToBlob(value: unknown): unknown {
  if (value instanceof Uint8Array) return new Blob([value]);
  if (value instanceof ArrayBuffer) return new Blob([new Uint8Array(value)]);
  if (Array.isArray(value)) return value.map(rpcBinaryToBlob);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = rpcBinaryToBlob(item);
    return result;
  }
  return value;
}

/** Restores Blob values to Uint8Array before plugin code sees them. */
export async function rpcBinaryFromBlob(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (Array.isArray(value)) return Promise.all(value.map(rpcBinaryFromBlob));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = await rpcBinaryFromBlob(item);
    }
    return result;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value: unknown): string {
  const visit = (current: unknown): string => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") { if (!Number.isFinite(current)) throw new Error("manifest contains non-finite number"); return JSON.stringify(current); }
    if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
    if (typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${visit(item)}`).join(",")}}`;
    }
    throw new Error("manifest contains unsupported value");
  };
  return visit(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256BytesHex(value: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const bytes = value instanceof Blob
    ? new Uint8Array(await value.arrayBuffer())
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
