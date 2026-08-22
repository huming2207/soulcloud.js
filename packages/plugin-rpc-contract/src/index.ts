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

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.instanceof(Blob)]);
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
  event: z.object({ id: z.string().min(1).max(128), kind: z.string().min(1).max(256), schema: z.number().int().positive(), receivedAt: z.string().datetime({ offset: true }), payload: z.unknown() }).strict(),
  installation: z.object({ id: z.string().min(1).max(128), projectId: z.string().uuid(), pluginId: z.string().min(1).max(128), pluginVersion: z.string().min(1).max(128), config: z.unknown() }).strict(),
  device: z.object({ id: z.string().uuid(), uid: z.string().min(1).max(256), profileId: z.string().min(1).max(128), profileVersion: z.number().int().positive() }).strict(),
}).strict();

export const eventOutput = z.object({
  updates: z.array(z.object({ entityKey: z.string().min(1).max(128), value: z.unknown().optional(), quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]).optional(), sourceTimestamp: z.string().datetime({ offset: true }).optional(), sequence: z.union([z.number().safe(), z.bigint()]).optional(), alarm: z.object({ level: z.enum(["info", "warning", "critical"]), code: z.string().min(1).max(256) }).strict().nullable().optional() }).strict()).max(4096).default([]),
  logs: z.array(z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string().min(1).max(4096) }).strict()).max(64).default([]),
}).strict();

export const actionInput = operation.extend({ actionId: z.string().min(1).max(128), input: z.unknown() }).strict();
export const actionOutput = z.object({ command: z.string().min(1).max(256), args: z.array(commandArgument).max(256), schemaVersion: z.number().int().positive() }).strict();

export const uiRenderInput = operation.extend({ routeId: z.string().min(1).max(128), installationId: z.string().uuid(), projectId: z.string().uuid(), user: uiUser, params: z.record(z.string().max(128), z.string().max(1024)).refine((value) => Object.keys(value).length <= 32) }).strict();
export const uiRenderOutput = z.object({ html: z.string().max(2 * 1024 * 1024), title: z.string().max(256).optional(), status: z.number().int().min(200).max(599).optional(), cache: z.literal("no-store").or(z.object({ maxAgeSeconds: z.number().int().nonnegative().max(86_400) })).optional() }).strict();
export const uiActionInput = uiRenderInput.extend({ action: z.unknown() }).strict();
export const uiActionOutput = z.object({ redirect: z.string().max(2048).optional(), errors: z.array(z.object({ field: z.string().max(128), message: z.string().max(2048) }).strict()).max(64).optional() }).strict();

export const entityGetInput = operation.extend({ entityKey: z.string().min(1).max(128) }).strict();
export const entityGetOutput = z.object({ entityKey: z.string(), value: z.unknown(), quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]), sourceTimestamp: z.string().datetime({ offset: true }).nullable(), ingestedAt: z.string().datetime({ offset: true }), alarm: z.object({ level: z.enum(["info", "warning", "critical"]), code: z.string() }).strict().nullable() }).strict().nullable();
export const commandEnqueueInput = operation.extend({ command: z.string().min(1).max(256), args: z.array(commandArgument).max(256) }).strict();
export const commandEnqueueOutput = z.object({ accepted: z.literal(true) }).strict();
export const pluginCallInput = operation.extend({ pluginId: z.string().min(1).max(128), procedure: z.string().min(1).max(256), input: z.unknown() }).strict();
export const pluginCallOutput = z.unknown();
export const uiDataInput = operation.extend({ key: z.string().min(1).max(128), input: z.unknown().optional() }).strict();
export const uiDataOutput = z.unknown();
export const pingInput = z.object({ nonce: z.string().min(1).max(128) }).strict();
export const pingOutput = pingInput;

const procedure = <Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(input: Input, output: Output, path: string[]) => oc.input(input).output(output).meta(meta.path(path));

export const managerToPluginContract = {
  system: {
    handshake: procedure(handshakeInput, handshakeOutput, ["system", "handshake"]),
    ping: procedure(pingInput, pingOutput, ["system", "ping"]),
  },
  plugin: { handleEvent: procedure(eventInput, eventOutput, ["plugin", "handleEvent"]) },
  action: { encode: procedure(actionInput, actionOutput, ["action", "encode"]) },
  ui: {
    render: procedure(uiRenderInput, uiRenderOutput, ["ui", "render"]),
    handleAction: procedure(uiActionInput, uiActionOutput, ["ui", "handleAction"]),
  },
};

export const pluginToManagerContract = {
  system: { ping: procedure(pingInput, pingOutput, ["system", "ping"]) },
  context: {
    entities: { get: procedure(entityGetInput, entityGetOutput, ["context", "entities", "get"]) },
    commands: { enqueue: procedure(commandEnqueueInput, commandEnqueueOutput, ["context", "commands", "enqueue"]) },
    plugins: { callScoped: procedure(pluginCallInput, pluginCallOutput, ["context", "plugins", "callScoped"]) },
    ui: { getData: procedure(uiDataInput, uiDataOutput, ["context", "ui", "getData"]) },
  },
};

export type ManagerToPluginContract = typeof managerToPluginContract;
export type PluginToManagerContract = typeof pluginToManagerContract;
export type HandshakeOutput = z.infer<typeof handshakeOutput>;
export type EventInput = z.infer<typeof eventInput>;
export type EventOutput = z.infer<typeof eventOutput>;
export type ActionInput = z.infer<typeof actionInput>;
export type ActionOutput = z.infer<typeof actionOutput>;
export type UiRenderInput = z.infer<typeof uiRenderInput>;
export type UiRenderOutput = z.infer<typeof uiRenderOutput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
export type CommandEnqueueInput = z.infer<typeof commandEnqueueInput>;
export type PluginCallInput = z.infer<typeof pluginCallInput>;

export interface RpcValueBudget { maxDepth: number; maxNodes: number; maxArrayItems: number; maxStringBytes: number; maxBlobs: number; maxBlobBytes: number; maxTotalBlobBytes: number }
export function assertRpcValueBudget(value: unknown, budget: RpcValueBudget): void {
  const seen = new WeakSet<object>(); let nodes = 0; let totalBlobBytes = 0; let blobs = 0; let strings = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1; if (nodes > budget.maxNodes) throw new Error("RPC value node limit exceeded");
    if (depth > budget.maxDepth) throw new Error("RPC value depth limit exceeded");
    if (typeof current === "string") { strings += new TextEncoder().encode(current).byteLength; if (strings > budget.maxStringBytes) throw new Error("RPC string byte limit exceeded"); return; }
    if (current instanceof Blob) { blobs += 1; totalBlobBytes += current.size; if (blobs > budget.maxBlobs || current.size > budget.maxBlobBytes || totalBlobBytes > budget.maxTotalBlobBytes) throw new Error("RPC Blob limit exceeded"); return; }
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) throw new Error("RPC cyclic value"); seen.add(current);
    if (Array.isArray(current)) { if (current.length > budget.maxArrayItems) throw new Error("RPC array item limit exceeded"); for (const value of current) visit(value, depth + 1); }
    else for (const value of Object.values(current)) visit(value, depth + 1);
    seen.delete(current);
  };
  visit(value, 0);
}

export function canonicalJson(value: unknown): string {
  const visit = (current: unknown): string => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") { if (!Number.isFinite(current)) throw new Error("manifest contains non-finite number"); return JSON.stringify(current); }
    if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
    if (typeof current === "object") { const entries = Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)); return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${visit(item)}`).join(",`)}}`; }
    throw new Error("manifest contains unsupported value");
  };
  return visit(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
