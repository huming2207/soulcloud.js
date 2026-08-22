import { meta, oc } from "@orpc/contract";
import { z } from "zod";

/** One WebSocket carries both directions; prefixes keep peer frames disjoint. */
export const PLUGIN_RPC_D2H_PREFIX = "soulcloud:d2h:v1:";
export const PLUGIN_RPC_H2D_PREFIX = "soulcloud:h2d:v1:";
export const PLUGIN_RPC_PATH = "/rpc/ws";
export const PLUGIN_RPC_PROTOCOL_HEADER = "1";

const prefixEncoder = new TextEncoder();
const d2hPrefixBytes = prefixEncoder.encode(PLUGIN_RPC_D2H_PREFIX);
const h2dPrefixBytes = prefixEncoder.encode(PLUGIN_RPC_H2D_PREFIX);

export function matchesRpcPrefix(data: string | ArrayBuffer | ArrayBufferView, prefix: string): boolean {
  if (typeof data === "string") return data.startsWith(prefix);
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const prefixBytes = prefix === PLUGIN_RPC_D2H_PREFIX
    ? d2hPrefixBytes
    : prefix === PLUGIN_RPC_H2D_PREFIX
      ? h2dPrefixBytes
      : prefixEncoder.encode(prefix);
  if (bytes.byteLength < prefixBytes.byteLength) return false;
  for (let index = 0; index < prefixBytes.byteLength; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  return true;
}
export const PLUGIN_RPC_API_VERSION = 1;

const scalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.bigint(),
  z.null(),
  z.instanceof(Blob),
]);

/** JSON-safe wire form of one DeviceCommand argument. */
export const commandArgument = z.object({
  name: z.string().min(1).max(256),
  value: scalar,
});

export const entityUpdate = z.object({
  entityKey: z.string().min(1).max(256),
  value: z.unknown().optional(),
  quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]).optional(),
  sourceTimestamp: z.string().datetime({ offset: true }).optional(),
  sequence: z.union([z.bigint(), z.number().safe()]).optional(),
  alarm: z
    .object({
      level: z.enum(["info", "warning", "critical"]),
      code: z.string().min(1).max(256),
    })
    .nullable()
    .optional(),
});

const operation = z.object({
  operationId: z.string().min(1).max(128),
  operationToken: z.string().min(16).max(512),
});

export const handshakeInput = z.object({
  rpcVersion: z.literal(2),
  pluginId: z.string().min(1).max(128),
  pluginVersion: z.string().min(1).max(128),
  apiVersion: z.number().int().positive(),
});

export const handshakeOutput = z.object({
  rpcVersion: z.literal(2),
  pluginId: z.string().min(1).max(128),
  pluginVersion: z.string().min(1).max(128),
  apiVersion: z.number().int().positive(),
});

export const handleEventInput = operation.extend({
  eventId: z.string().min(1).max(128),
  eventKind: z.string().min(1).max(256),
  schemaVersion: z.number().int().positive(),
  payload: z.unknown(),
  device: z.object({
    id: z.string().min(1).max(128),
    deviceUid: z.string().min(1).max(256),
    profileId: z.string().min(1).max(128),
    profileVersion: z.number().int().positive(),
  }),
  installation: z.object({
    id: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    config: z.unknown(),
  }),
  receivedAt: z.string().datetime({ offset: true }),
  deadlineMs: z.number().int().positive().max(600_000),
});

export const handleEventOutput = z.object({
  updates: z.array(entityUpdate).max(4096),
});

export const encodeActionInput = operation.extend({
  actionId: z.string().min(1).max(256),
  input: z.unknown(),
  deadlineMs: z.number().int().positive().max(600_000),
});

export const encodeActionOutput = z.object({
  cmd: z.string().min(1).max(256),
  args: z.array(commandArgument).max(256),
  schemaVersion: z.number().int().positive(),
});

export const entityGetInput = operation.extend({
  entityKey: z.string().min(1).max(256),
});

export const entityGetOutput = z
  .object({
    entityKey: z.string().min(1).max(256),
    value: z.unknown(),
    quality: z.enum(["good", "bad", "uncertain", "stale", "unknown"]),
    sourceTimestamp: z.string().datetime({ offset: true }).nullable(),
    ingestedAt: z.string().datetime({ offset: true }),
    alarm: z
      .object({
        level: z.enum(["info", "warning", "critical"]),
        code: z.string().min(1).max(256),
      })
      .nullable(),
  })
  .nullable();

export const commandEnqueueInput = operation.extend({
  command: z.string().min(1).max(256),
  args: z.array(commandArgument).max(256),
});

export const commandEnqueueOutput = z.object({ ok: z.literal(true) });

export const pingInput = z.object({ nonce: z.string().min(1).max(128) });
export const pingOutput = z.object({ nonce: z.string().min(1).max(128) });

const procedure = <TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  input: TInput,
  output: TOutput,
  path: string[],
) => oc.input(input).output(output).meta(meta.path(path));

/** Dispatcher -> host procedures. */
export const dispatcherToHostContract = {
  system: {
    handshake: procedure(handshakeInput, handshakeOutput, ["system", "handshake"]),
    ping: procedure(pingInput, pingOutput, ["system", "ping"]),
  },
  plugin: {
    handleEvent: procedure(handleEventInput, handleEventOutput, ["plugin", "handleEvent"]),
  },
  action: {
    encode: procedure(encodeActionInput, encodeActionOutput, ["action", "encode"]),
  },
};

/** Host -> dispatcher procedures used by a running plugin operation. */
export const hostToDispatcherContract = {
  system: {
    ping: procedure(pingInput, pingOutput, ["system", "ping"]),
  },
  context: {
    entities: {
      get: procedure(entityGetInput, entityGetOutput, ["context", "entities", "get"]),
    },
    commands: {
      enqueue: procedure(commandEnqueueInput, commandEnqueueOutput, ["context", "commands", "enqueue"]),
    },
  },
};

export type DispatcherToHostContract = typeof dispatcherToHostContract;
export type HostToDispatcherContract = typeof hostToDispatcherContract;

export type CommandArgumentWire = z.infer<typeof commandArgument>;
export type EntityUpdateWire = z.infer<typeof entityUpdate>;
export type HandleEventInput = z.infer<typeof handleEventInput>;
export type HandleEventOutput = z.infer<typeof handleEventOutput>;
export type EncodeActionInput = z.infer<typeof encodeActionInput>;
export type EncodeActionOutput = z.infer<typeof encodeActionOutput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
export type EntityGetOutput = z.infer<typeof entityGetOutput>;
export type CommandEnqueueInput = z.infer<typeof commandEnqueueInput>;

export interface RpcValueBudget {
  maxDepth: number;
  maxNodes: number;
  maxArrayItems: number;
  maxStringBytes: number;
  maxBlobs: number;
  maxBlobBytes: number;
  maxTotalBlobBytes: number;
}

/**
 * Bounds unknown JSON/Blob values before business validation or Blob reads.
 * Repeated object references are rejected as cycles/aliasing so the walker
 * never needs to retain an unbounded graph of visited nodes.
 */
export function assertRpcValueBudget(value: unknown, budget: RpcValueBudget): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let blobCount = 0;
  let blobBytes = 0;
  let stringBytes = 0;
  const accountBlob = (size: number): void => {
    blobCount += 1;
    blobBytes += size;
    if (blobCount > budget.maxBlobs) throw new Error("RPC Blob count limit exceeded");
    if (size > budget.maxBlobBytes) throw new Error("RPC Blob size limit exceeded");
    if (blobBytes > budget.maxTotalBlobBytes) throw new Error("RPC total Blob bytes limit exceeded");
  };
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) throw new Error("RPC value node limit exceeded");
    if (depth > budget.maxDepth) throw new Error("RPC value depth limit exceeded");
    if (typeof current === "string") {
      stringBytes += Buffer.byteLength(current, "utf8");
      if (stringBytes > budget.maxStringBytes) throw new Error("RPC string byte limit exceeded");
      return;
    }
    if (current instanceof Blob) {
      accountBlob(current.size);
      return;
    }
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      accountBlob(current.byteLength);
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) throw new Error("RPC value contains a cycle or repeated object");
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > budget.maxArrayItems) throw new Error("RPC array item limit exceeded");
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const entries = Object.entries(current);
    if (entries.length > budget.maxArrayItems) throw new Error("RPC object item limit exceeded");
    for (const [key, item] of entries) {
      stringBytes += Buffer.byteLength(key, "utf8");
      if (stringBytes > budget.maxStringBytes) throw new Error("RPC string byte limit exceeded");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
