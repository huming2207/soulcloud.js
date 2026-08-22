import { meta, oc } from "@orpc/contract";
import { z } from "zod";

/** One WebSocket carries both directions; prefixes keep peer frames disjoint. */
export const PLUGIN_RPC_D2H_PREFIX = "soulcloud:d2h:v1:";
export const PLUGIN_RPC_H2D_PREFIX = "soulcloud:h2d:v1:";
export const PLUGIN_RPC_PATH = "/rpc/ws";
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

/** Dispatcher -> host procedures. */
export const dispatcherToHostContract = {
  handshake: oc.input(handshakeInput).output(handshakeOutput).meta(meta.path(["handshake"])),
  handleEvent: oc.input(handleEventInput).output(handleEventOutput).meta(meta.path(["handleEvent"])),
  encodeAction: oc.input(encodeActionInput).output(encodeActionOutput).meta(meta.path(["encodeAction"])),
  ping: oc.input(pingInput).output(pingOutput).meta(meta.path(["ping"])),
};

/** Host -> dispatcher procedures used by a running plugin operation. */
export const hostToDispatcherContract = {
  entityGet: oc.input(entityGetInput).output(entityGetOutput).meta(meta.path(["entityGet"])),
  commandEnqueue: oc.input(commandEnqueueInput).output(commandEnqueueOutput).meta(meta.path(["commandEnqueue"])),
  ping: oc.input(pingInput).output(pingOutput).meta(meta.path(["ping"])),
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
