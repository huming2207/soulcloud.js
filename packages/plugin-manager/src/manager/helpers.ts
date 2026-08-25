import { assertRpcValueBudget, type CommandEnqueueInput } from "@soulcloud/plugin-rpc-contract";
import { createHash } from "node:crypto";
import type { CommandArgument, DebugExecutionRecord, DeviceCommand } from "@soulcloud/core";

export const DEBUG_SESSION_CAPABILITIES = [
  "execution.get",
  "execution.renew_lease",
  "execution.release",
  "execution.complete",
  "device.enqueue_command",
  "device.get_command",
  "device.cancel_command",
] as const;

/** Preserve whether an encoded action was explicitly approved by a human. */
export function actionCommandOrigin(humanApproved?: boolean): "human" | "plugin" {
  return humanApproved === true ? "human" : "plugin";
}

export function publicError(message: string, status: number, publicCode: string): Error {
  return Object.assign(new Error(message), { status, publicCode });
}


export async function normalizeCommandArguments(value: unknown): Promise<CommandArgument[]> {
  if (!Array.isArray(value) || value.length > 256) throw new Error("command arguments must be an array of at most 256 items");
  const result: CommandArgument[] = [];
  const names = new Set<string>();
  for (const argument of value) {
    if (!argument || typeof argument !== "object" || Array.isArray(argument)) {
      throw new Error("each command argument must be an object");
    }
    const record = argument as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length < 1 || record.name.length > 256 || !Object.prototype.hasOwnProperty.call(record, "value")) {
      throw new Error("each command argument must contain a bounded name and value");
    }
    if (names.has(record.name)) throw new Error(`command argument ${record.name} is duplicated`);
    names.add(record.name);
    const raw = record.value;
    const commandValue = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw;
    if (commandValue !== null && typeof commandValue !== "string" && typeof commandValue !== "bigint" && typeof commandValue !== "boolean" && !(typeof commandValue === "number" && Number.isFinite(commandValue)) && !(commandValue instanceof Uint8Array)) {
      throw new Error(`command argument ${record.name} must be scalar`);
    }
    result.push({ [record.name]: commandValue as CommandArgument[string] });
  }
  return result;
}

/** Convert the normalized wire argument list back to the manifest action input shape. */
export function commandArgumentsToActionInput(args: readonly CommandArgument[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const argument of args) {
    const keys = Object.keys(argument);
    if (keys.length !== 1) throw new Error("command arguments must contain exactly one key each");
    const key = keys[0]!;
    if (Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`command argument ${key} is duplicated`);
    const value = argument[key];
    if (typeof value === "bigint") {
      if (!Number.isSafeInteger(Number(value))) throw new Error(`command argument ${key} exceeds the action schema number range`);
      input[key] = Number(value);
    } else {
      input[key] = value;
    }
  }
  return input;
}


export const unavailable = async (): Promise<never> => { throw new Error("plugin reverse RPC is not configured"); };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ActiveOperation {
  kind: "action" | "event" | "ui" | "configure" | "plugin-call" | "debug-session-bootstrap";
  operationTokenHash: Buffer;
  connectionId: string;
  installationId: string;
  projectId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash?: string;
  deviceId?: string;
  profileId?: string;
  profileVersion?: number;
  stagedCommands?: Array<{ deviceId: string; command: DeviceCommand }>;
  stagedCommandCount: number;
  stagedCommandBytes: number;
  deadline: number;
  state: "active" | "sealed";
  reverseCalls: number;
  inFlightReverseCalls: number;
  reverseSettledWaiters: Set<() => void>;
  userId?: string;
  pluginCallDepth?: number;
}

export interface CachedExecutionCapability {
  installationId: string;
  deviceId: string;
  token: string;
  expiresAt: number;
}

export interface PluginCircuit {
  failures: number;
  openedAt: number;
  probeInProgress: boolean;
  probeStartedAt?: number;
  lastTouchedAt?: number;
}

export const PLUGIN_CIRCUIT_IDLE_RETENTION_MS = 10 * 60_000;
// A half-open probe must not pin an installation forever if the process loses
// the leased event or exits before dispatch reaches its normal cleanup path.
// The event RPC deadline is at most 30 seconds, so this leaves a small grace
// period without allowing overlapping probes during a healthy request.
export const PLUGIN_CIRCUIT_PROBE_TIMEOUT_MS = 35_000;


export function commandIntentBytes(command: string, args: CommandEnqueueInput["args"]): number {
  let bytes = Buffer.byteLength(command);
  for (const argument of args) {
    bytes += Buffer.byteLength(argument.name);
    const value = argument.value;
    if (value instanceof Blob) bytes += value.size;
    else if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (typeof value === "bigint") bytes += value.toString().length;
    else bytes += 8;
  }
  return bytes;
}


export async function* splitArtifactBody(body: ReadableStream<Uint8Array>, deadline = performance.now() + 600_000): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let carry: Uint8Array | null = null;
  let completed = false;
  try {
    for (;;) {
      const next = await readArtifactChunk(reader, deadline);
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;
      let current: Uint8Array;
      if (carry) {
        const previous = carry;
        current = new Uint8Array(previous.byteLength + value.byteLength);
        current.set(previous);
        current.set(value, previous.byteLength);
      } else {
        current = value;
      }
      carry = null;
      let offset = 0;
      while (current.byteLength - offset > 64 * 1024) {
        yield current.subarray(offset, offset + 64 * 1024);
        offset += 64 * 1024;
      }
      if (offset < current.byteLength) carry = current.subarray(offset);
    }
    if (carry && carry.byteLength > 0) yield carry;
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function artifactChunkTimeout(chunkTimeoutMs: number, deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw publicError("artifact upload timed out", 504, "plugin_timeout");
  return Math.max(1, Math.min(chunkTimeoutMs, remaining));
}

export async function readArtifactChunk(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, deadline: number): Promise<{ done: boolean; value?: Uint8Array }> {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw publicError("artifact upload timed out", 504, "plugin_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(publicError("artifact upload timed out", 504, "plugin_timeout")), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function hashOperationToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function executionScopeKey(installationId: string, deviceId: string): string {
  return `${installationId}\u0000${deviceId}`;
}

export function decrementCounter(counters: Map<string, number>, key: string): void {
  const next = (counters.get(key) ?? 1) - 1;
  if (next === 0) counters.delete(key);
  else counters.set(key, next);
}