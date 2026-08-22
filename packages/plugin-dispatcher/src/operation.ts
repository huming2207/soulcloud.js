import type {
  CommandEnqueueInput,
  EntityGetInput,
} from "@soulcloud/plugin-rpc-contract";
import type {
  CommandArgument,
  CommandArgValue,
  EntityStateSnapshot,
} from "@soulcloud/plugin-sdk";
import type { PluginEventRow } from "@soulcloud/core";

export interface StagedPluginCommand {
  command: string;
  args: CommandArgument[];
}

export interface OperationLimits {
  maxOperations: number;
  maxReverseInFlight: number;
  perPluginReverseInFlight: number;
  perInstallationReverseInFlight: number;
  perOperationReverseInFlight: number;
  maxReverseCallsPerOperation: number;
  maxStagedCommandsPerOperation: number;
  maxBlobsPerOperation: number;
  maxBlobBytesPerBlob: number;
  maxBlobBytesPerOperation: number;
}

export class PluginOperationLimitError extends Error {
  readonly code = "overloaded";

  constructor(message: string) {
    super(message);
    this.name = "PluginOperationLimitError";
  }
}

interface OperationState {
  readonly operationId: string;
  readonly token: string;
  readonly event: PluginEventRow;
  readonly connectionId: string;
  readonly deadlineAt: number;
  activeReverseCalls: number;
  totalReverseCalls: number;
  stagedCommands: StagedPluginCommand[];
  blobCount: number;
  blobBytes: number;
  sealed: boolean;
}

function createOperationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export interface FinishedPluginOperation {
  operationId: string;
  token: string;
  activeReverseCalls: number;
  stagedCommands: StagedPluginCommand[];
}

type EntityReader = (
  event: PluginEventRow,
  entityKey: string,
  signal: AbortSignal,
) => Promise<EntityStateSnapshot | null>;

export class PluginOperationRegistry {
  private readonly operations = new Map<string, OperationState>();
  private activeReverseInFlight = 0;
  private readonly pluginReverseInFlight = new Map<string, number>();
  private readonly installationReverseInFlight = new Map<string, number>();

  constructor(
    private readonly limits: OperationLimits,
    private readonly readEntity: EntityReader,
  ) {}

  begin(event: PluginEventRow, deadlineMs: number, connectionId = "local"): { operationId: string; token: string } {
    if (this.operations.size >= this.limits.maxOperations) {
      throw new PluginOperationLimitError("maximum concurrent plugin operations reached");
    }
    const state: OperationState = {
      operationId: crypto.randomUUID(),
      token: createOperationToken(),
      event,
      connectionId,
      // This deadline only governs in-process RPC capability lifetime. Use a
      // monotonic clock so wall-clock adjustments cannot extend or truncate
      // an operation; durable event leases continue to use database time.
      deadlineAt: performance.now() + deadlineMs,
      activeReverseCalls: 0,
      totalReverseCalls: 0,
      stagedCommands: [],
      blobCount: 0,
      blobBytes: 0,
      sealed: false,
    };
    this.operations.set(state.token, state);
    return { operationId: state.operationId, token: state.token };
  }

  async entityGet(input: EntityGetInput, signal: AbortSignal, connectionId = "local"): Promise<EntityStateSnapshot | null> {
    const state = this.acquire(input.operationId, input.operationToken, connectionId);
    try {
      return await this.readEntity(state.event, input.entityKey, signal);
    } finally {
      this.release(state);
    }
  }

  async commandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId = "local"): Promise<{ ok: true }> {
    const state = this.acquire(input.operationId, input.operationToken, connectionId);
    try {
      if (state.stagedCommands.length >= this.limits.maxStagedCommandsPerOperation) {
        throw new PluginOperationLimitError("maximum staged commands per operation reached");
      }
      signal.throwIfAborted();
      let blobCount = 0;
      let blobBytes = 0;
      const args: CommandArgument[] = [];
      for (const arg of input.args) {
        let value: CommandArgValue;
        if (arg.value instanceof Blob) {
          const blob = arg.value;
          blobCount += 1;
          blobBytes += blob.size;
          if (blob.size > this.limits.maxBlobBytesPerBlob) {
            throw new PluginOperationLimitError("maximum Blob size reached");
          }
          if (blobCount > this.limits.maxBlobsPerOperation || state.blobCount + blobCount > this.limits.maxBlobsPerOperation) {
            throw new PluginOperationLimitError("maximum operation Blob count reached");
          }
          if (blobBytes > this.limits.maxBlobBytesPerOperation || state.blobBytes + blobBytes > this.limits.maxBlobBytesPerOperation) {
            throw new PluginOperationLimitError("maximum operation Blob bytes reached");
          }
          value = new Uint8Array(await blob.arrayBuffer());
        } else {
          value = arg.value;
        }
        args.push({ [arg.name]: value });
      }
      signal.throwIfAborted();
      if (state.sealed) throw new Error("plugin operation is already sealed");
      state.blobCount += blobCount;
      state.blobBytes += blobBytes;
      state.stagedCommands.push({ command: input.command, args });
      return { ok: true };
    } finally {
      this.release(state);
    }
  }

  finish(token: string): FinishedPluginOperation | null {
    const state = this.operations.get(token);
    if (!state) return null;
    state.sealed = true;
    this.operations.delete(token);
    return {
      operationId: state.operationId,
      token: state.token,
      activeReverseCalls: state.activeReverseCalls,
      stagedCommands: state.stagedCommands.slice(),
    };
  }

  discard(token: string): void {
    const state = this.operations.get(token);
    if (!state) return;
    state.sealed = true;
    this.operations.delete(token);
  }

  private acquire(operationId: string, token: string, connectionId: string): OperationState {
    const state = this.operations.get(token);
    if (!state || state.sealed || state.operationId !== operationId || state.connectionId !== connectionId) {
      throw new Error("plugin operation is not active");
    }
    if (performance.now() >= state.deadlineAt) throw new Error("plugin operation deadline exceeded");
    const pluginInFlight = this.pluginReverseInFlight.get(state.event.pluginId) ?? 0;
    const installationInFlight = this.installationReverseInFlight.get(state.event.pluginInstallationId) ?? 0;
    if (
      this.activeReverseInFlight >= this.limits.maxReverseInFlight ||
      pluginInFlight >= this.limits.perPluginReverseInFlight ||
      installationInFlight >= this.limits.perInstallationReverseInFlight ||
      state.activeReverseCalls >= this.limits.perOperationReverseInFlight
    ) {
      throw new PluginOperationLimitError("reverse RPC concurrency limit reached");
    }
    if (state.totalReverseCalls >= this.limits.maxReverseCallsPerOperation) {
      throw new PluginOperationLimitError("maximum reverse RPC calls per operation reached");
    }
    state.activeReverseCalls += 1;
    state.totalReverseCalls += 1;
    this.activeReverseInFlight += 1;
    this.pluginReverseInFlight.set(state.event.pluginId, pluginInFlight + 1);
    this.installationReverseInFlight.set(state.event.pluginInstallationId, installationInFlight + 1);
    return state;
  }

  private release(state: OperationState): void {
    state.activeReverseCalls -= 1;
    this.activeReverseInFlight -= 1;
    this.decrement(this.pluginReverseInFlight, state.event.pluginId);
    this.decrement(this.installationReverseInFlight, state.event.pluginInstallationId);
  }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }
}
