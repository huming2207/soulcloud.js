/**
 * Plugin-side scoped context (§6.4).
 *
 * The host constructs the PluginContext handed to worker code. In this
 * stage the context carries installation identity, a logger that is returned
 * as bounded per-request log entries, and the deadline signal.
 * The scoped services (devices/commands/entities/jobs) are declared in
 * the SDK for forward compatibility; their implementations require the
 * reverse RPC channel that later stages add — using them now fails with
 * a clear error instead of silently doing nothing.
 */

import type {
  CommandArgument,
  EntityStateSnapshot,
  PluginContext,
  PluginLogger,
  ScopedCommandService,
  ScopedDeviceService,
  ScopedEntityService,
  ScopedJobService,
} from "@soulcloud/plugin-sdk";

export interface PluginContextBindings {
  getEntity?: (entityKey: string, signal: AbortSignal) => Promise<EntityStateSnapshot | null>;
  enqueueCommand?: (command: string, args: CommandArgument[], signal: AbortSignal) => Promise<void>;
  getDeviceUid?: () => Promise<string>;
}

function notImplemented(service: string, method: string): never {
  throw new Error(
    `${service}.${method} is not implemented in this stage: it requires the ` +
      `dispatcher <-> host reverse RPC channel (planned with action dispatch, ` +
      `docs/zh/plugin-and-station-architecture.md §6.4)`,
  );
}

const jobs: ScopedJobService = {
  async createJob() {
    notImplemented("jobs", "createJob");
  },
};

export interface ContextTags {
  pluginId: string;
  installationId: string;
  projectId: string;
  /** The event being handled (operation_id, §6.4). */
  operationId: string;
}

export function createPluginContext(
  installation: { id: string; projectId: string; config: unknown },
  signal: AbortSignal,
  tags: ContextTags,
  emitLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void,
  bindings: PluginContextBindings = {},
): PluginContext {
  const logger: PluginLogger = {
    debug: (message, fields) => emitLog("debug", message, fields),
    info: (message, fields) => emitLog("info", message, fields),
    warn: (message, fields) => emitLog("warn", message, fields),
    error: (message, fields) => emitLog("error", message, fields),
  };
  const devices: ScopedDeviceService = {
    async getDeviceUid() {
      if (!bindings.getDeviceUid) notImplemented("devices", "getDeviceUid");
      return bindings.getDeviceUid();
    },
  };
  const commands: ScopedCommandService = {
    async enqueueCommand(command, args) {
      if (!bindings.enqueueCommand) notImplemented("commands", "enqueueCommand");
      return bindings.enqueueCommand(command, args, signal);
    },
  };
  const entities: ScopedEntityService = {
    async get(entityKey) {
      if (!bindings.getEntity) notImplemented("entities", "get");
      return bindings.getEntity(entityKey, signal);
    },
  };
  void tags;
  return {
    installation,
    devices,
    commands,
    entities,
    jobs,
    logger,
    signal,
  };
}
