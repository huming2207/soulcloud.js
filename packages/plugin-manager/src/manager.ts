import { validateActionInput, validateEntityUpdates, validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import {
  DEFAULT_RPC_VALUE_BUDGET,
  assertRpcValueBudget,
  artifactChunkOutput,
  artifactReadChunkOutput,
  canonicalJson,
  configureTargetOutput,
  debugSessionStartOutput,
  debugSessionAbortOutput,
  eventOutput,
  listTargetConfigsOutput,
  listArtifactsOutput,
  uiAssetOutput,
  uiRenderOutput,
  uiActionOutput,
  sha256BytesHex,
  sha256Hex,
  type CommandEnqueueInput,
  type EntityGetInput,
  type ExecutionCompleteInput,
  type ExecutionGetInput,
  type ExecutionOutput,
  type ExecutionReleaseInput,
  type ExecutionRenewLeaseInput,
  type DeviceEnqueueInput,
  type DeviceGetInput,
  type DeviceCancelInput,
  type DeviceCommandOutput,
  type HandshakeOutput,
  type PluginCallInput,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";
import {
  completePluginEvent,
  completePluginEventWithUpdates,
  decodeDeviceEvent,
  enqueueBatchInTransaction,
  getPluginEntityState,
  bindDeviceToPluginInstallation,
  completeDebugExecution,
  createPluginInstallation,
  createDebugExecution,
  enqueueDebugCommand,
  expireDebugExecutions,
  getDebugExecutionCapability,
  revalidateDebugSessionExecution,
  getDebugCommand,
  listDebugCommands,
  getDebugExecution,
  consumePluginUiGrant,
  purgePluginUiGrants,
  migratePluginInstallation,
  reconcilePluginInstallation,
  releaseDebugExecution,
  releaseDebugExecutionForUser,
  renewDebugExecutionLeaseForUser,
  requestDebugCommandCancellation,
  renewDebugExecutionLease,
  setPluginInstallationState,
  leasePluginEvents,
  releasePluginEvent,
  renewPluginEventLeases,
  purgePluginData,
  Prisma,
  type LeasedPluginEvent,
  type EntityUpdateInput,
  type EntityDescriptorInput,
  type CommandArgument,
  type DeviceCommand,
  type DebugExecutionRecord,
  type PluginUiSession,
  type BindDeviceInput,
  type CreateInstallationInput,
  type PrismaClient,
  DebugExecutionCapabilityError,
} from "@soulcloud/core";
import { PluginConnection, type PluginConnectionOptions, type ReverseHandlers } from "./connection";
import { createHash, timingSafeEqual } from "node:crypto";

export interface PluginManagerOptions {
  endpoints: ReadonlyMap<string, string>;
  authToken: string;
  maxFrameBytes: number;
  maxPendingRequests: number;
  maxOperations?: number;
  maxOperationsPerPlugin?: number;
  maxOperationsPerInstallation?: number;
  maxReverseCallsPerOperation?: number;
  maxPluginCallDepth?: number;
  maxReverseConcurrency?: number;
  maxReverseConcurrencyPerPlugin?: number;
  maxReverseConcurrencyPerInstallation?: number;
  maxStagedCommands?: number;
  maxStagedCommandBytes?: number;
  valueBudget?: Partial<RpcValueBudget>;
  backpressureBytes: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  connectTimeoutMs?: number;
  reconnectMs: number;
  prisma?: PrismaClient;
  uiSessionSecret?: string;
  uiSessionTtlSeconds?: number;
  manifestStore?: ManifestStore;
  reverseHandlers?: Partial<ReverseHandlers>;
  eventStore?: PluginEventStore;
  eventPollIntervalMs?: number;
  eventLeaseMs?: number;
  eventBatchSize?: number;
  eventMaxConcurrency?: number;
  eventTimeoutMs?: number;
  eventMaxAttempts?: number;
  eventRetentionDays?: number;
  historyRetentionDays?: number;
  maintenanceIntervalMs?: number;
  retentionBatchSize?: number;
  retentionMaxBatches?: number;
  /** Absolute wall-clock budget for reading and forwarding one artifact body. */
  artifactUploadTimeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const DEBUG_SESSION_CAPABILITIES = [
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

export interface PluginEventStore {
  lease(limit: number, leaseMs: number): Promise<LeasedPluginEvent[]>;
  complete(eventId: string, leaseToken: string): Promise<boolean>;
  completeWithUpdates?(eventId: string, leaseToken: string, context: PluginEventCompletionContext): Promise<boolean>;
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number, consumeAttempt?: boolean): Promise<boolean>;
  renew?(leases: readonly { id: string; leaseToken: string }[], leaseMs: number): Promise<number>;
  purge?(eventRetentionDays: number, historyRetentionDays: number, batchSize: number): Promise<{ events: number; history: number }>;
}

export interface PluginEventCompletionContext {
  installationId: string;
  deviceId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  profileId: string;
  profileVersion: number;
  snapshotDescriptors: readonly EntityDescriptorInput[];
  updates: readonly EntityUpdateInput[];
  commands?: readonly { deviceId: string; command: DeviceCommand }[];
}

export class PrismaPluginEventStore implements PluginEventStore {
  constructor(private readonly prisma: PrismaClient) {}
  lease(limit: number, leaseMs: number) { return leasePluginEvents(this.prisma, limit, leaseMs); }
  complete(eventId: string, leaseToken: string) { return completePluginEvent(this.prisma, eventId, leaseToken); }
  completeWithUpdates(eventId: string, leaseToken: string, context: PluginEventCompletionContext) {
    return completePluginEventWithUpdates(this.prisma, eventId, leaseToken, context);
  }
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number, consumeAttempt = true) {
    return releasePluginEvent(this.prisma, eventId, leaseToken, permanent, error, retryMs, consumeAttempt);
  }
  renew(leases: readonly { id: string; leaseToken: string }[], leaseMs: number) { return renewPluginEventLeases(this.prisma, leases, leaseMs); }
  purge(eventRetentionDays: number, historyRetentionDays: number, batchSize: number) { return purgePluginData(this.prisma, eventRetentionDays, historyRetentionDays, batchSize); }
}

export interface CatalogEntry {
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  manifest: PluginManifest;
  connected: boolean;
}

export interface ManifestStore {
  list(): Promise<Array<{ pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest }>>;
  get(pluginId: string, pluginVersion: string): Promise<{ manifestHash: string; manifest: PluginManifest } | null>;
  insert(snapshot: { pluginId: string; pluginVersion: string; manifestHash: string; apiVersion: number; manifest: PluginManifest }): Promise<{ manifestHash: string; manifest: PluginManifest }>;
}

/** PostgreSQL is the durable source of truth; no manifest is compiled here. */
export class PrismaManifestStore implements ManifestStore {
  constructor(private readonly prisma: PrismaClient) {}
  async list() {
    const rows = await this.prisma.pluginManifestSnapshot.findMany({ orderBy: [{ pluginId: "asc" }, { firstSeenAt: "desc" }] });
    return rows.map((row) => ({ pluginId: row.pluginId, pluginVersion: row.pluginVersion, manifestHash: row.manifestHash.trim(), manifest: validateManifest(row.canonicalManifest) }));
  }
  async get(pluginId: string, pluginVersion: string) {
    const row = await this.prisma.pluginManifestSnapshot.findUnique({ where: { pluginId_pluginVersion: { pluginId, pluginVersion } } });
    return row ? { manifestHash: row.manifestHash.trim(), manifest: validateManifest(row.canonicalManifest) } : null;
  }
  async insert(snapshot: { pluginId: string; pluginVersion: string; manifestHash: string; apiVersion: number; manifest: PluginManifest }): Promise<{ manifestHash: string; manifest: PluginManifest }> {
    try {
      await this.prisma.pluginManifestSnapshot.create({ data: { pluginId: snapshot.pluginId, pluginVersion: snapshot.pluginVersion, manifestHash: snapshot.manifestHash, canonicalManifest: snapshot.manifest as unknown as Prisma.InputJsonValue, apiVersion: snapshot.apiVersion } });
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error;
    }
    const persisted = await this.get(snapshot.pluginId, snapshot.pluginVersion);
    if (!persisted) throw new Error("plugin manifest snapshot disappeared after insert");
    return persisted;
  }
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

function publicError(message: string, status: number, publicCode: string): Error {
  return Object.assign(new Error(message), { status, publicCode });
}

/**
 * Convert the wire-level command argument list into the core device command
 * representation. The RPC contract already validates this shape, but keep a
 * second boundary check here: this is the last point before data is persisted
 * in the device command queue, and it must never rely on a TypeScript cast.
 */
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

const unavailable = async (): Promise<never> => { throw new Error("plugin reverse RPC is not configured"); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveOperation {
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

interface CachedExecutionCapability {
  installationId: string;
  deviceId: string;
  token: string;
  expiresAt: number;
}

interface PluginCircuit {
  failures: number;
  openedAt: number;
  probeInProgress: boolean;
  lastTouchedAt?: number;
}

const PLUGIN_CIRCUIT_IDLE_RETENTION_MS = 10 * 60_000;

export class PluginManager {
  private readonly connections = new Map<string, PluginConnection>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly operations = new Map<string, ActiveOperation>();
  private readonly operationsByPlugin = new Map<string, number>();
  private readonly operationsByInstallation = new Map<string, number>();
  private reverseInFlight = 0;
  private readonly reverseInFlightByPlugin = new Map<string, number>();
  private readonly reverseInFlightByInstallation = new Map<string, number>();
  /**
   * Raw execution tokens are intentionally process-local.  The database only
   * stores their hashes; this cache lets a device event continue an execution
   * that was started by this Manager without widening the persisted secret
   * surface.  A Manager restart safely drops the cache and therefore drops
   * event-side device capabilities until explicit recovery is implemented.
   */
  private readonly executionTokens = new Map<string, CachedExecutionCapability>();
  private readonly executionByDevice = new Map<string, string>();
  private readonly circuits = new Map<string, PluginCircuit>();
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private eventPollRunning: Promise<void> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning: Promise<void> | null = null;
  private stopping = false;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private readonly valueBudget: RpcValueBudget;

  constructor(private readonly options: PluginManagerOptions) {
    this.log = options.log ?? ((message, fields) => console.log(`[soulcloud-plugin-manager] ${message}`, fields ?? ""));
    this.valueBudget = { ...DEFAULT_RPC_VALUE_BUDGET, ...options.valueBudget };
  }

  async start(): Promise<void> {
    if (this.options.manifestStore) {
      for (const entry of await this.options.manifestStore.list()) {
        const manifest = validateManifest(entry.manifest);
        const computed = await sha256Hex(canonicalJson(manifest));
        if (manifest.id !== entry.pluginId || manifest.version !== entry.pluginVersion || computed !== entry.manifestHash) {
          throw new Error(`stored plugin manifest snapshot is invalid for ${entry.pluginId}@${entry.pluginVersion}`);
        }
        this.catalog.set(`${entry.pluginId}@${entry.pluginVersion}`, { ...entry, manifest, connected: false });
      }
    }
    for (const [pluginId] of this.options.endpoints) void this.connect(pluginId);
    if (this.options.eventStore) {
      const interval = this.options.eventPollIntervalMs ?? 500;
      this.eventTimer = setInterval(() => this.consumeEvents(), interval);
      this.eventTimer.unref?.();
      this.consumeEvents();
    }
    if (this.options.eventStore?.purge || this.options.prisma) {
      const interval = this.options.maintenanceIntervalMs ?? 3_600_000;
      this.maintenanceTimer = setInterval(() => this.maintain(), interval);
      this.maintenanceTimer.unref?.();
    }
  }

  async consumePluginUiGrant(nonce: string, expiresAt: Date | string): Promise<boolean> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    return consumePluginUiGrant(this.options.prisma, nonce, expiresAt);
  }

  private maintain(): void {
    if (this.stopping || this.maintenanceRunning || (!this.options.eventStore?.purge && !this.options.prisma)) return;
    const running = this.runMaintenance();
    this.maintenanceRunning = running;
    void running.finally(() => {
      if (this.maintenanceRunning === running) this.maintenanceRunning = null;
    });
  }

  private async runMaintenance(): Promise<void> {
    const batchSize = this.options.retentionBatchSize ?? 2_000;
    const maxBatches = this.options.retentionMaxBatches ?? 8;
    let events = 0;
    let history = 0;
    let executions = 0;
    let leases = 0;
    let uiGrants = 0;
    try {
      this.pruneExecutionCapabilities();
      this.pruneCircuits();
      if (this.options.prisma) {
        const result = await expireDebugExecutions(this.options.prisma, Math.min(batchSize, 10_000));
        executions = result.executions;
        leases = result.leases;
        uiGrants = await purgePluginUiGrants(this.options.prisma, Math.min(batchSize, 10_000));
      }
      if (this.options.eventStore?.purge) {
        for (let batch = 0; batch < maxBatches && !this.stopping; batch += 1) {
          const result = await this.options.eventStore.purge(
            this.options.eventRetentionDays ?? 30,
            this.options.historyRetentionDays ?? 30,
            batchSize,
          );
          events += result.events;
          history += result.history;
          if (result.events < batchSize && result.history < batchSize) break;
        }
      }
      this.log("plugin maintenance sweep completed", { events, history, executions, leases, uiGrants });
    } catch (error) {
      this.log("plugin retention sweep failed", { error: (error as Error).message });
    }
  }

  async createInstallation(input: CreateInstallationInput): Promise<{ id: string }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    this.assertConfigurationBudget(input.config);
    this.requireConnectedManifest(input.pluginId, input.pluginVersion, input.manifestHash);
    return createPluginInstallation(this.options.prisma, input);
  }

  async bindDevice(input: BindDeviceInput): Promise<void> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    return bindDeviceToPluginInstallation(this.options.prisma, input);
  }

  /** Start a durable capability after Human API has authorized the request. */
  async startDebugExecution(input: {
    installationId: string;
    projectId: string;
    deviceId: string;
    userId: string;
    allowedCapabilities: readonly string[];
    leaseMs: number;
    ttlMs: number;
  }): Promise<{ execution: DebugExecutionRecord; executionToken: string }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const executionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const execution = await createDebugExecution(this.options.prisma, {
      installationId: installation.id,
      deviceId: input.deviceId,
      initiatingUserId: input.userId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      manifestHash: installation.manifestHash.trim(),
      allowedCapabilities: input.allowedCapabilities,
      tokenHash: hashCapabilityToken(executionToken),
      leaseMs: input.leaseMs,
      ttlMs: input.ttlMs,
    });
    this.cacheExecutionCapability(execution, executionToken);
    return { execution, executionToken };
  }

  /**
   * Create the platform execution and pass its raw capability only through a
   * one-shot Manager -> plugin bootstrap RPC. The caller receives no token.
   */
  async startDebugSession(input: {
    installationId: string;
    projectId: string;
    deviceId: string;
    userId: string;
    caseId: string;
    targetConfigId?: string | null;
    targetConfigRevision?: number | null;
    targetId?: string | null;
    artifactId?: string | null;
    deviceFirmwareVersion?: string | null;
    leaseMs: number;
    ttlMs: number;
    timeoutMs?: number;
  }): Promise<{ execution: DebugExecutionRecord; sessionId: string }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    let started: { execution: DebugExecutionRecord; executionToken: string } | undefined;
    let operationId: string | undefined;
    let bootstrapSessionId: string | undefined;
    let bootstrapConnection: PluginConnection | undefined;
    let bootstrapInstallation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string } | undefined;
    try {
      started = await this.startDebugExecution({
        installationId: input.installationId,
        projectId: input.projectId,
        deviceId: input.deviceId,
        userId: input.userId,
        allowedCapabilities: DEBUG_SESSION_CAPABILITIES,
        leaseMs: input.leaseMs,
        ttlMs: input.ttlMs,
      });
      const execution = started.execution;
      const installation = await this.options.prisma.pluginInstallation.findUnique({
        where: { id: input.installationId },
        select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
      });
      if (!installation || installation.state !== "enabled" || installation.projectId !== input.projectId) throw new Error("plugin installation changed while starting debug session");
      const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
      bootstrapConnection = connection;
      bootstrapInstallation = { ...installation, manifestHash: installation.manifestHash.trim() };
      operationId = crypto.randomUUID();
      const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const timeoutMs = input.timeoutMs ?? 30_000;
      this.registerOperation(operationId, {
        kind: "debug-session-bootstrap",
        operationTokenHash: hashOperationToken(operationToken),
        connectionId: connection.id,
        installationId: installation.id,
        projectId: installation.projectId,
        pluginId: installation.pluginId,
        pluginVersion: installation.pluginVersion,
        manifestHash: installation.manifestHash.trim(),
        deviceId: input.deviceId,
        userId: input.userId,
        deadline: performance.now() + timeoutMs,
        state: "active",
        reverseCalls: 0,
        inFlightReverseCalls: 0,
        stagedCommandCount: 0,
        stagedCommandBytes: 0,
        reverseSettledWaiters: new Set(),
      });
      const output = await connection.request("debugger.startSession", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        deviceId: input.deviceId,
        userId: input.userId,
        pluginVersion: installation.pluginVersion,
        manifestHash: installation.manifestHash.trim(),
        executionId: execution.id,
        executionToken: started.executionToken,
        caseId: input.caseId,
        ...(input.targetConfigId !== undefined ? { targetConfigId: input.targetConfigId } : {}),
        ...(input.targetConfigRevision !== undefined ? { targetConfigRevision: input.targetConfigRevision } : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
        ...(input.deviceFirmwareVersion !== undefined ? { deviceFirmwareVersion: input.deviceFirmwareVersion } : {}),
      }, timeoutMs);
      const parsed = debugSessionStartOutput.parse(output);
      bootstrapSessionId = parsed.sessionId;
      // Record the private session before validating the echoed execution ID.
      // A buggy plugin can create a session successfully and then return a
      // malformed envelope; cleanup must still be able to mark that session
      // failed using the platform execution scope.
      if (parsed.executionId !== execution.id) throw new Error("plugin returned a different debug execution id");
      await this.sealOperation(operationId);
      let currentExecution: DebugExecutionRecord;
      try {
        currentExecution = await revalidateDebugSessionExecution(this.options.prisma, {
          executionId: execution.id,
          tokenHash: hashCapabilityToken(started.executionToken),
          installationId: installation.id,
          projectId: installation.projectId,
          deviceId: input.deviceId,
          pluginId: installation.pluginId,
          pluginVersion: installation.pluginVersion,
          manifestHash: installation.manifestHash.trim(),
        });
      } catch (error) {
        if (error instanceof DebugExecutionCapabilityError) {
          throw publicError("debug execution changed while starting debug session", 409, "conflict");
        }
        throw error;
      }
      return { execution: currentExecution, sessionId: parsed.sessionId };
    } catch (error) {
      if (bootstrapConnection && bootstrapInstallation && started) {
        await this.abortDebugSessionBestEffort({
          connection: bootstrapConnection,
          installation: bootstrapInstallation,
          deviceId: input.deviceId,
          executionId: started.execution.id,
          sessionId: bootstrapSessionId,
          userId: input.userId,
          reason: "debug session bootstrap did not complete successfully",
          timeoutMs: Math.min(input.timeoutMs ?? 30_000, 5_000),
        });
      }
      if (started) {
        await completeDebugExecution(this.options.prisma, started.execution.id, hashCapabilityToken(started.executionToken), "failed").catch(() => undefined);
        this.forgetExecutionCapability(started.execution.id);
      }
      throw error;
    } finally {
      if (operationId) this.finishOperation(operationId);
    }
  }

  private async abortDebugSessionBestEffort(input: {
    connection: PluginConnection;
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string };
    deviceId: string;
    executionId: string;
    sessionId?: string;
    userId: string;
    reason: string;
    timeoutMs: number;
  }): Promise<void> {
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    try {
      this.registerOperation(operationId, {
        kind: "debug-session-bootstrap",
        operationTokenHash: hashOperationToken(operationToken),
        connectionId: input.connection.id,
        installationId: input.installation.id,
        projectId: input.installation.projectId,
        pluginId: input.installation.pluginId,
        pluginVersion: input.installation.pluginVersion,
        manifestHash: input.installation.manifestHash,
        deviceId: input.deviceId,
        userId: input.userId,
        deadline: performance.now() + input.timeoutMs,
        state: "active",
        reverseCalls: 0,
        inFlightReverseCalls: 0,
        stagedCommandCount: 0,
        stagedCommandBytes: 0,
        reverseSettledWaiters: new Set(),
      });
      const output = await input.connection.request("debugger.abortSession", {
        operationId,
        operationToken,
        installationId: input.installation.id,
        projectId: input.installation.projectId,
        deviceId: input.deviceId,
        executionId: input.executionId,
        sessionId: input.sessionId ?? null,
        reason: input.reason,
      }, input.timeoutMs);
      const parsed = debugSessionAbortOutput.parse(output);
      if (
        parsed.executionId !== input.executionId ||
        (input.sessionId !== undefined && input.sessionId !== null && parsed.sessionId !== input.sessionId)
      ) {
        throw new Error("plugin returned an invalid debug session cleanup output");
      }
      await this.sealOperation(operationId);
    } catch (error) {
      this.log("debug session cleanup failed", { sessionId: input.sessionId, executionId: input.executionId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.finishOperation(operationId);
    }
  }

  async getDebugExecution(executionId: string): Promise<DebugExecutionRecord | null> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    return getDebugExecution(this.options.prisma, executionId);
  }

  async getDebugExecutionForScope(input: { executionId: string; installationId: string; projectId: string; userId: string }): Promise<DebugExecutionRecord | null> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(input.userId)) return null;
    const [execution, installation, membership] = await Promise.all([
      getDebugExecution(this.options.prisma, input.executionId),
      this.options.prisma.pluginInstallation.findUnique({ where: { id: input.installationId }, select: { projectId: true } }),
      this.options.prisma.userProject.findUnique({ where: { userId_projectId: { userId: input.userId, projectId: input.projectId } }, select: { userId: true } }),
    ]);
    if (!execution || execution.installationId !== input.installationId) return null;
    if (!installation || installation.projectId !== input.projectId || !membership) return null;
    return execution;
  }

  async listDebugCommandsForUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<ReturnType<typeof listDebugCommands>> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    await this.assertUiSessionCurrent(session as PluginUiSession);
    const execution = await this.getDebugExecutionForScope({ executionId, installationId: session.installationId, projectId: session.projectId, userId: session.sub });
    if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
      throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
    }
    return listDebugCommands(this.options.prisma, executionId, 64);
  }

  /** Return execution lifecycle state to a scoped plugin-origin debugger page. */
  async getDebugExecutionForUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
    await this.assertUiSessionCurrent(session as PluginUiSession);
    const execution = await this.getDebugExecutionForScope({
      executionId,
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
    });
    if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
      throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
    }
    return execution;
  }

  /** Request cancellation of one command from the authenticated debugger UI.
   * The initiating user and the in-memory execution capability remain
   * required; a browser cannot manufacture a cancellation token after a
   * Manager restart. */
  async cancelDebugCommandFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    commandId: string,
  ): Promise<ReturnType<typeof requestDebugCommandCancellation>> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(executionId) || !UUID.test(commandId)) throw publicError("debug execution or command ID must be a UUID", 400, "invalid_request");
    await this.assertUiSessionCurrent(session as PluginUiSession);
    const execution = await this.getDebugExecutionForScope({
      executionId,
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
    });
    if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
      throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
    }
    if (execution.initiatingUserId !== session.sub) {
      throw publicError("only the execution initiating user can cancel its commands", 403, "forbidden");
    }
    const cached = this.executionTokens.get(execution.id);
    if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(execution.id);
      throw publicError("debug execution capability is no longer available", 409, "conflict");
    }
    return requestDebugCommandCancellation(this.options.prisma, execution.id, hashCapabilityToken(cached.token), commandId);
  }

  /** Request one device-command cancellation from the Human API user scope. */
  async cancelDebugCommandForUser(input: {
    executionId: string;
    commandId: string;
    installationId: string;
    projectId: string;
    userId: string;
  }): Promise<ReturnType<typeof requestDebugCommandCancellation>> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(input.executionId) || !UUID.test(input.commandId) || !UUID.test(input.installationId) || !UUID.test(input.projectId) || !UUID.test(input.userId)) {
      throw publicError("debug command scope must contain UUIDs", 400, "invalid_request");
    }
    const execution = await this.getDebugExecutionForScope({
      executionId: input.executionId,
      installationId: input.installationId,
      projectId: input.projectId,
      userId: input.userId,
    });
    if (!execution) throw publicError("debug execution is not available to this user", 404, "not_found");
    if (execution.initiatingUserId !== input.userId) {
      throw publicError("only the execution initiating user can cancel its commands", 403, "forbidden");
    }
    const cached = this.executionTokens.get(execution.id);
    if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(execution.id);
      throw publicError("debug execution capability is no longer available", 409, "conflict");
    }
    return requestDebugCommandCancellation(this.options.prisma, execution.id, hashCapabilityToken(cached.token), input.commandId);
  }

  /**
   * Release a debugger device lease from the authenticated plugin-origin UI.
   * The raw execution token is intentionally only available in this Manager
   * process; after a restart the UI must not be able to reconstruct it.
   */
  async releaseDebugExecutionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
    await this.assertUiSessionCurrent(session as PluginUiSession);
    const execution = await this.getDebugExecutionForScope({
      executionId,
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
    });
    if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
      throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
    }
    if (execution.initiatingUserId !== session.sub) {
      throw publicError("only the execution initiating user can release this lease", 403, "forbidden");
    }
    const cached = this.executionTokens.get(execution.id);
    if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(execution.id);
      throw publicError("debug execution capability is no longer available", 409, "conflict");
    }
    const released = await releaseDebugExecutionForUser(this.options.prisma, {
      executionId: execution.id,
      tokenHash: hashCapabilityToken(cached.token),
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
    });
    this.forgetExecutionDeviceScope(execution.id);
    return released;
  }

  /**
   * Pause a debugger execution from the Human API's authenticated user scope.
   * This is deliberately the same lease-release operation used by the plugin
   * UI: it stops new cloud-side device control, but does not claim that an
   * already broker-accepted command has stopped on the hardware.
   */
  async pauseDebugExecutionForUser(input: {
    executionId: string;
    installationId: string;
    projectId: string;
    userId: string;
  }): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(input.executionId) || !UUID.test(input.installationId) || !UUID.test(input.projectId) || !UUID.test(input.userId)) {
      throw publicError("debug execution scope must contain UUIDs", 400, "invalid_request");
    }
    const execution = await this.getDebugExecutionForScope(input);
    if (!execution) throw publicError("debug execution is not available to this user", 404, "not_found");
    if (execution.initiatingUserId !== input.userId) {
      throw publicError("only the execution initiating user can pause this execution", 403, "forbidden");
    }
    const cached = this.executionTokens.get(execution.id);
    if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(execution.id);
      throw publicError("debug execution capability is no longer available", 409, "conflict");
    }
    const paused = await releaseDebugExecutionForUser(this.options.prisma, {
      executionId: execution.id,
      tokenHash: hashCapabilityToken(cached.token),
      installationId: input.installationId,
      projectId: input.projectId,
      userId: input.userId,
    });
    this.forgetExecutionDeviceScope(execution.id);
    return paused;
  }

  /** Renew an execution lease from the same human-scoped plugin UI session. */
  async renewDebugExecutionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    leaseMs: number,
  ): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) throw publicError("debug execution lease is invalid", 400, "invalid_request");
    await this.assertUiSessionCurrent(session as PluginUiSession);
    const execution = await this.getDebugExecutionForScope({
      executionId,
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
    });
    if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
      throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
    }
    if (execution.initiatingUserId !== session.sub) {
      throw publicError("only the execution initiating user can renew this lease", 403, "forbidden");
    }
    const cached = this.executionTokens.get(execution.id);
    if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(execution.id);
      throw publicError("debug execution capability is no longer available", 409, "conflict");
    }
    return renewDebugExecutionLeaseForUser(this.options.prisma, {
      executionId: execution.id,
      tokenHash: hashCapabilityToken(cached.token),
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
      leaseMs,
    });
  }

  async renewDebugExecution(executionId: string, executionToken: string, leaseMs: number): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    return renewDebugExecutionLease(this.options.prisma, executionId, hashCapabilityToken(executionToken), leaseMs);
  }

  async releaseDebugExecution(executionId: string, executionToken: string): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const result = await releaseDebugExecution(this.options.prisma, executionId, hashCapabilityToken(executionToken));
    this.forgetExecutionDeviceScope(executionId);
    return result;
  }

  async completeDebugExecution(executionId: string, executionToken: string, state: "completed" | "failed"): Promise<DebugExecutionRecord> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const result = await completeDebugExecution(this.options.prisma, executionId, hashCapabilityToken(executionToken), state);
    this.forgetExecutionCapability(executionId);
    return result;
  }

  async setInstallationState(installationId: string, state: "enabled" | "disabled"): Promise<void> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (state === "enabled") {
      const installation = await this.options.prisma.pluginInstallation.findUnique({
        where: { id: installationId },
        select: { pluginId: true, pluginVersion: true, manifestHash: true },
      });
      if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
      this.requireConnectedManifest(
        installation.pluginId,
        installation.pluginVersion,
        installation.manifestHash.trim(),
      );
    }
    return setPluginInstallationState(this.options.prisma, installationId, state);
  }

  async migrateInstallation(installationId: string, pluginVersion: string, manifestHash: string, config: unknown): Promise<void> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    this.assertConfigurationBudget(config);
    const installation = await this.options.prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { pluginId: true } });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    this.requireConnectedManifest(installation.pluginId, pluginVersion, manifestHash);
    return migratePluginInstallation(this.options.prisma, installationId, pluginVersion, manifestHash, config);
  }

  async reconcileInstallation(installationId: string): Promise<void> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    return reconcilePluginInstallation(this.options.prisma, installationId);
  }

  async encodeAction(input: {
    installationId: string;
    userId: string;
    deviceId: string;
    actionId: string;
    actionInput: unknown;
    executionId?: string;
    humanApproved?: boolean;
    timeoutMs?: number;
  }): Promise<{ batchId: string; deviceCount: number }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (input.executionId !== undefined && !UUID.test(input.executionId)) {
      throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
    }
    if (input.executionId !== undefined && !UUID.test(input.userId)) {
      throw publicError("debug execution user ID must be a UUID", 400, "invalid_request");
    }
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw new Error("plugin installation not found");
    if (installation.state !== "enabled") throw new Error("plugin installation is disabled");
    const manifest = this.getManifest(installation.pluginId, installation.pluginVersion);
    if (!manifest || manifest.version !== installation.pluginVersion) throw new Error("plugin manifest is unavailable");
    const action = manifest.actions.find((item) => item.id === input.actionId);
    if (!action) throw publicError("action is not declared by the plugin manifest", 404, "action_not_found");
    if (action.requiresHumanApproval && input.humanApproved !== true) {
      throw publicError("this device operation requires explicit human approval", 403, "human_approval_required");
    }
    const validInput = validateActionInput(action.inputSchema, input.actionInput);
    if (!validInput.ok) throw publicError(`invalid action input: ${validInput.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; ")}`, 400, "invalid_action_input");
    try {
      assertRpcValueBudget(input.actionInput, this.valueBudget);
    } catch (error) {
      throw publicError(`invalid action input: ${(error as Error).message}`, 400, "invalid_action_input");
    }
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.registerOperation(operationId, {
      kind: "action",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      deviceId: input.deviceId,
      userId: input.userId,
      deadline: performance.now() + (input.timeoutMs ?? 30_000),
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      let encoded: { command: string; args: Array<{ name: string; value: unknown }>; schemaVersion: number };
      try {
        encoded = await connection.request("action.encode", {
          operationId,
          operationToken,
          installationId: installation.id,
          projectId: installation.projectId,
          deviceId: input.deviceId,
          userId: input.userId,
          actionId: input.actionId,
          input: input.actionInput,
        }, input.timeoutMs ?? 30_000) as { command: string; args: Array<{ name: string; value: unknown }>; schemaVersion: number };
        try {
          assertRpcValueBudget(encoded, this.valueBudget);
        } catch (error) {
          throw new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`);
        }
        await this.sealOperation(operationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/INVALID_PLUGIN_OUTPUT|plugin encoder/i.test(message)) throw publicError(`plugin encoder output invalid: ${message}`, 502, "invalid_action_output");
        throw error;
      }
      if (!encoded || encoded.command !== action.wire.command || encoded.schemaVersion !== action.wire.schemaVersion || !Array.isArray(encoded.args)) {
        throw publicError("plugin encoder output invalid: command, schemaVersion or args are malformed", 502, "invalid_action_output");
      }
      let args: CommandArgument[];
      try {
        args = await normalizeCommandArguments(encoded.args);
      } catch (error) {
        throw publicError(`plugin encoder output invalid: ${(error as Error).message}`, 502, "invalid_action_output");
      }
      let encodedInput: Record<string, unknown>;
      try {
        encodedInput = commandArgumentsToActionInput(args);
      } catch (error) {
        throw publicError(`plugin encoder output invalid: ${(error as Error).message}`, 502, "invalid_action_output");
      }
      const encodedValidation = validateActionInput(action.inputSchema, encodedInput);
      if (!encodedValidation.ok) {
        throw publicError(`plugin encoder output invalid: ${encodedValidation.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; ")}`, 502, "invalid_action_output");
      }
      const batch = await this.options.prisma.$transaction(async (tx) => {
        const installationRows = await tx.$queryRaw<Array<{ id: string; project_id: string; plugin_id: string; plugin_version: string; manifest_hash: string; state: string }>>`
          SELECT id, project_id, plugin_id, plugin_version, manifest_hash, state
          FROM plugin_installations
          WHERE id = ${installation.id}::uuid
          FOR UPDATE
        `;
        const lockedInstallation = installationRows[0];
        if (!lockedInstallation || lockedInstallation.state !== "enabled" || lockedInstallation.plugin_id !== installation.pluginId || lockedInstallation.plugin_version !== installation.pluginVersion || lockedInstallation.manifest_hash.trim() !== installation.manifestHash.trim()) {
          throw new Error("plugin installation changed while encoding action");
        }
        const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
          SELECT id, project_id FROM devices WHERE id = ${input.deviceId}::uuid FOR UPDATE
        `;
        const lockedDevice = deviceRows[0];
        if (!lockedDevice) throw new Error("device not found");
        if (lockedDevice.project_id !== lockedInstallation.project_id) {
          throw new Error("device and plugin installation belong to different projects");
        }
        const binding = await tx.pluginDeviceBinding.findUnique({ where: { deviceId: input.deviceId }, select: { installationId: true } });
        if (!binding || binding.installationId !== installation.id) throw new Error("device is not bound to the plugin installation");
        let executionId: string | undefined;
        if (input.executionId !== undefined) {
          const membershipRows = await tx.$queryRaw<Array<{ user_id: string }>>`
            SELECT user_id
            FROM user_projects
            WHERE user_id = ${input.userId}::uuid
              AND project_id = ${lockedInstallation.project_id}::uuid
            FOR SHARE
          `;
          if (!membershipRows[0]) throw publicError("project membership is no longer valid", 403, "forbidden");
          const executionRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM debug_executions
            WHERE id = ${input.executionId}::uuid
              AND installation_id = ${installation.id}::uuid
              AND device_id = ${input.deviceId}::uuid
              AND initiating_user_id = ${input.userId}::uuid
              AND allowed_capabilities ? 'device.enqueue_command'
              AND state = 'active'
              AND device_lease_expires_at > CURRENT_TIMESTAMP
              AND expires_at > CURRENT_TIMESTAMP
            FOR UPDATE
          `;
          if (!executionRows[0]) throw publicError("debug execution is not active for this device", 409, "conflict");
          executionId = executionRows[0].id;
        }
        return enqueueBatchInTransaction(tx, [input.deviceId], { cmd: encoded.command, args }, {
          provenance: {
            // The public Human API marks its authenticated action request as
            // explicitly approved. Preserve that distinction in platform
            // provenance; otherwise a destructive human operation is
            // indistinguishable from a plugin-origin command in the audit
            // trail. Internal callers that do not provide approval remain
            // plugin-origin commands and still require plugin provenance.
            originType: actionCommandOrigin(input.humanApproved),
            originUserId: input.userId,
            pluginInstallationId: installation.id,
            pluginVersion: installation.pluginVersion,
            manifestHash: installation.manifestHash.trim(),
            executionId,
            correlationId: operationId,
          },
        });
      });
      return { batchId: batch.id, deviceCount: batch.deviceCount };
    } finally {
      this.finishOperation(operationId);
    }
  }

  async configureTarget(input: {
    installationId: string;
    projectId: string;
    userId: string;
    yaml: string;
    timeoutMs?: number;
  }): Promise<{ configId: string; revision: number; sha256: string; targetCount: number }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    this.assertConfigurationBudget(input.yaml);
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.registerOperation(operationId, {
      kind: "configure",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      let result: unknown;
      try {
        result = await connection.request("debugger.configureTarget", {
          operationId,
          operationToken,
          installationId: installation.id,
          projectId: installation.projectId,
          userId: input.userId,
          yaml: input.yaml,
        }, timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("INVALID_TARGET_CONFIG")) throw publicError(message, 400, "invalid_request");
        throw error;
      }
      let output: ReturnType<typeof configureTargetOutput.parse>;
      try {
        assertRpcValueBudget(result, this.valueBudget);
        output = configureTargetOutput.parse(result);
      } catch (error) {
        throw publicError(`plugin target configuration output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
      }
      await this.assertInstallationSnapshotCurrent(installation, "plugin installation changed while configuring target");
      return output;
    } finally {
      this.finishOperation(operationId);
    }
  }

  async listTargetConfigs(input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ configId: string; revision: number; sha256: string; targetCount: number; createdAt: string }>> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.registerOperation(operationId, {
      kind: "configure",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      const result = await connection.request("debugger.listTargetConfigs", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        userId: input.userId,
      }, timeoutMs);
      let output: ReturnType<typeof listTargetConfigsOutput.parse>;
      try {
        assertRpcValueBudget(result, this.valueBudget);
        output = listTargetConfigsOutput.parse(result);
      } catch (error) {
        throw publicError(`plugin target configuration list output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
      }
      await this.assertInstallationSnapshotCurrent(installation, "plugin installation changed while listing target configurations");
      return output;
    } finally {
      this.finishOperation(operationId);
    }
  }

  async listArtifacts(input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ artifactId: string; kind: "elf" | "firmware"; filename: string; contentType: string; size: number; sha256: string; metadata: Record<string, string | number>; createdAt: string }>> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.registerOperation(operationId, {
      kind: "configure",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      const result = await connection.request("debugger.listArtifacts", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        userId: input.userId,
      }, timeoutMs);
      let output: ReturnType<typeof listArtifactsOutput.parse>;
      try {
        assertRpcValueBudget(result, this.valueBudget);
        output = listArtifactsOutput.parse(result);
      } catch (error) {
        throw publicError(`plugin artifact list output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
      }
      await this.assertInstallationSnapshotCurrent(installation, "plugin installation changed while listing artifacts");
      return output;
    } finally {
      this.finishOperation(operationId);
    }
  }

  /** Read one bounded artifact chunk from plugin-private storage. This is a
   * manager primitive for a future device transfer gateway; it does not expose
   * the plugin database or choose push-vs-pull transport semantics. */
  async readArtifactChunk(input: {
    installationId: string;
    projectId: string;
    userId: string;
    artifactId: string;
    offset: number;
    length: number;
    timeoutMs?: number;
  }): Promise<{ artifactId: string; offset: number; totalSize: number; sha256: string; chunk: Uint8Array; final: boolean }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 64 * 1024 * 1024) throw publicError("artifact offset is invalid", 400, "invalid_request");
    if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > 64 * 1024) throw publicError("artifact chunk length is invalid", 400, "invalid_request");
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.registerOperation(operationId, {
      kind: "configure",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      const result = await connection.request("debugger.readArtifactChunk", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        userId: input.userId,
        artifactId: input.artifactId,
        offset: input.offset,
        length: input.length,
      }, timeoutMs);
      let output: { artifactId: string; offset: number; totalSize: number; sha256: string; chunk: Uint8Array; final: boolean };
      try {
        assertRpcValueBudget(result, this.valueBudget);
        const parsed = artifactReadChunkOutput.parse(result);
        const chunk = new Uint8Array(await parsed.chunk.arrayBuffer());
        if (parsed.artifactId !== input.artifactId || parsed.offset !== input.offset || chunk.byteLength > input.length || parsed.offset + chunk.byteLength > parsed.totalSize || parsed.final !== (parsed.offset + chunk.byteLength === parsed.totalSize)) {
          throw new Error("artifact chunk bounds or identity do not match the request");
        }
        output = { artifactId: parsed.artifactId, offset: parsed.offset, totalSize: parsed.totalSize, sha256: parsed.sha256, chunk, final: parsed.final };
      } catch (error) {
        throw publicError(`plugin artifact chunk output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
      }
      await this.assertInstallationSnapshotCurrent(installation, "plugin installation changed while reading artifact");
      return output;
    } finally {
      this.finishOperation(operationId);
    }
  }

  async uploadArtifact(input: {
    installationId: string;
    projectId: string;
    userId: string;
    caseId?: string;
    kind: "elf" | "firmware";
    filename: string;
    contentType: string;
    uploadId: string;
    totalSize: number;
    body: ReadableStream<Uint8Array>;
    timeoutMs?: number;
    /** When present, pin this upload to the already-authenticated plugin UI snapshot. */
    uiSession?: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">;
  }): Promise<{ uploadId: string; artifactId: string; sha256: string; size: number; kind: "elf" | "firmware"; filename: string }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    if (!Number.isSafeInteger(input.totalSize) || input.totalSize <= 0 || input.totalSize > 64 * 1024 * 1024) throw publicError("artifact size is invalid", 413, "payload_too_large");
    if (input.uiSession && (
      input.uiSession.installationId !== input.installationId ||
      input.uiSession.projectId !== input.projectId ||
      input.uiSession.sub !== input.userId
    )) {
      throw publicError("plugin UI session scope does not match the artifact upload", 403, "plugin_ui_session_invalid");
    }
    const installation = await this.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
    if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
    if (input.uiSession && (
      installation.pluginId !== input.uiSession.pluginId ||
      installation.pluginVersion !== input.uiSession.pluginVersion ||
      installation.manifestHash.trim().toLowerCase() !== input.uiSession.manifestHash.trim().toLowerCase()
    )) {
      throw publicError("plugin UI session is no longer valid", 403, "plugin_ui_session_invalid");
    }
    if (input.uiSession) await this.assertUiSessionCurrent(input.uiSession, installation);
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const uploadId = input.uploadId;
    const chunkTimeoutMs = input.timeoutMs ?? 30_000;
    const uploadDeadline = performance.now() + (this.options.artifactUploadTimeoutMs ?? 600_000);
    let offset = 0;
    let bodyBytes = 0;
    let previous: Uint8Array | null = null;
    for await (const chunk of splitArtifactBody(input.body, uploadDeadline)) {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > input.totalSize) throw publicError("artifact body exceeds the declared content length", 400, "invalid_request");
      if (previous) {
        const progress = await this.sendArtifactChunk(connection, { installation, uploadId, userId: input.userId, caseId: input.caseId, kind: input.kind, filename: input.filename, contentType: input.contentType, totalSize: input.totalSize, offset, final: false, chunk: previous }, artifactChunkTimeout(chunkTimeoutMs, uploadDeadline));
        // A retry may reach an upload that already completed before the
        // previous HTTP response was delivered. The private store returns
        // the original artifact for that idempotency key; return it without
        // creating a second artifact or replaying the remaining chunks.
        if (typeof progress !== "number") {
          await this.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
          return { uploadId, artifactId: progress.artifactId, sha256: progress.sha256, size: input.totalSize, kind: input.kind, filename: input.filename };
        }
        offset = progress;
      }
      previous = chunk;
    }
    if (!previous) throw Object.assign(new Error("artifact body is empty"), { status: 400 });
    if (bodyBytes !== input.totalSize) throw publicError("artifact body is shorter than the declared content length", 400, "invalid_request");
    await this.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
    const result = await this.sendArtifactChunk(connection, { installation, uploadId, userId: input.userId, caseId: input.caseId, kind: input.kind, filename: input.filename, contentType: input.contentType, totalSize: input.totalSize, offset, final: true, chunk: previous }, artifactChunkTimeout(chunkTimeoutMs, uploadDeadline), true);
    if (typeof result === "number") throw publicError("plugin did not complete artifact upload", 502, "invalid_plugin_output");
    await this.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
    return { uploadId, artifactId: result.artifactId, sha256: result.sha256, size: input.totalSize, kind: input.kind, filename: input.filename };
  }

  private async assertArtifactInstallationSnapshotCurrent(
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },
    uiSession?: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
  ): Promise<void> {
    await this.assertInstallationSnapshotCurrent(
      installation,
      uiSession ? "plugin UI session is no longer valid" : "plugin installation changed while uploading artifact",
      uiSession ? { status: 403, publicCode: "plugin_ui_session_invalid" } : undefined,
    );
    if (uiSession) await this.assertUiSessionCurrent(uiSession, installation);
  }

  private async assertInstallationSnapshotCurrent(
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string },
    message: string,
    options?: { status: number; publicCode: string },
  ): Promise<void> {
    const current = await this.options.prisma!.pluginInstallation.findUnique({
      where: { id: installation.id },
      select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (
      !current ||
      current.projectId !== installation.projectId ||
      current.pluginId !== installation.pluginId ||
      current.pluginVersion !== installation.pluginVersion ||
      current.manifestHash.trim().toLowerCase() !== installation.manifestHash.trim().toLowerCase() ||
      current.state !== "enabled"
    ) {
      throw publicError(message, options?.status ?? 409, options?.publicCode ?? "conflict");
    }
  }

  private async sendArtifactChunk(
    connection: PluginConnection,
    input: { installation: { id: string; projectId: string; pluginId: string; pluginVersion: string }; uploadId: string; userId: string; caseId?: string; kind: "elf" | "firmware"; filename: string; contentType: string; totalSize: number; offset: number; final: boolean; chunk: Uint8Array },
    timeoutMs: number,
    expectFinal = false,
  ): Promise<number | { artifactId: string; sha256: string }> {
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.registerOperation(operationId, {
      kind: "configure",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: input.installation.id,
      projectId: input.installation.projectId,
      pluginId: input.installation.pluginId,
      pluginVersion: input.installation.pluginVersion,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      let output: ReturnType<typeof artifactChunkOutput.parse>;
      try {
        output = artifactChunkOutput.parse(await connection.request("debugger.storeArtifactChunk", {
          operationId,
          operationToken,
          installationId: input.installation.id,
          projectId: input.installation.projectId,
          userId: input.userId,
          uploadId: input.uploadId,
          ...(input.caseId ? { caseId: input.caseId } : {}),
          kind: input.kind,
          filename: input.filename,
          contentType: input.contentType,
          totalSize: input.totalSize,
          offset: input.offset,
          final: input.final,
          chunk: input.chunk,
        }, timeoutMs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("INVALID_ARTIFACT_INPUT")) throw publicError(message, 400, "invalid_request");
        throw error;
      }
      if (output.uploadId !== input.uploadId) {
        throw publicError("plugin returned an artifact upload ID that does not match the request", 502, "invalid_plugin_output");
      }
      if (input.final) {
        if (!output.complete || !output.artifactId || !output.sha256) throw publicError("plugin did not complete artifact upload", 502, "invalid_plugin_output");
        return { artifactId: output.artifactId, sha256: output.sha256 };
      }
      if (output.complete) {
        if (expectFinal || !output.artifactId || !output.sha256) throw publicError("plugin returned an invalid completed artifact", 502, "invalid_plugin_output");
        return { artifactId: output.artifactId, sha256: output.sha256 };
      }
      if (output.receivedBytes !== input.offset + input.chunk.byteLength) throw publicError("plugin returned an invalid artifact upload progress", 502, "invalid_plugin_output");
      return output.receivedBytes;
    } finally {
      this.finishOperation(operationId);
    }
  }

  async renderPluginUi(session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>): Promise<unknown> {
    return this.callUi(session, "ui.render", { requestId, params });
  }

  async handlePluginUiAction(session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>, action: unknown): Promise<unknown> {
    return this.callUi(session, "ui.handleAction", { requestId, params, action });
  }

  /**
   * Execute one manifest action from an authenticated plugin-origin UI
   * session. The session was minted by Human API, so this is the explicit
   * per-click human approval path; the plugin never receives a service token
   * and cannot invoke this method over reverse RPC.
   */
  async encodeActionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    input: { deviceId: string; actionId: string; actionInput: unknown; executionId?: string; timeoutMs?: number },
  ): Promise<{ batchId: string; deviceCount: number }> {
    await this.assertUiSessionCurrent(session as PluginUiSession);
    return this.encodeAction({
      installationId: session.installationId,
      userId: session.sub,
      deviceId: input.deviceId,
      actionId: input.actionId,
      actionInput: input.actionInput,
      executionId: input.executionId,
      humanApproved: true,
      timeoutMs: input.timeoutMs,
    });
  }

  /**
   * Start a debugger session from the authenticated plugin-origin UI. The
   * short-lived UI session supplies the current user/project scope; callers
   * cannot provide a different identity or installation.
   */
  async startDebugSessionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    input: {
      deviceId: string;
      caseId: string;
      targetConfigId?: string | null;
      targetConfigRevision?: number | null;
      targetId?: string | null;
      artifactId?: string | null;
      deviceFirmwareVersion?: string | null;
      leaseMs: number;
      ttlMs: number;
      timeoutMs?: number;
    },
  ): Promise<{ execution: DebugExecutionRecord; sessionId: string }> {
    await this.assertUiSessionCurrent(session as PluginUiSession);
    return this.startDebugSession({
      installationId: session.installationId,
      projectId: session.projectId,
      userId: session.sub,
      ...input,
    });
  }

  async getPluginUiAsset(session: PluginUiSession, requestId: string, assetPath: string): Promise<unknown> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    await this.assertUiSessionCurrent(session);
    const manifest = this.getManifest(session.pluginId, session.pluginVersion);
    const descriptor = manifest?.ui?.assets?.find((asset) => asset.path === assetPath);
    if (!descriptor) throw Object.assign(new Error("plugin UI asset is not declared"), { status: 404 });
    const { connection } = this.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.registerOperation(operationId, {
      kind: "ui",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: session.installationId,
      projectId: session.projectId,
      pluginId: session.pluginId,
      pluginVersion: session.pluginVersion,
      userId: session.sub,
      deadline: performance.now() + 30_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      const result = await connection.request("ui.asset", {
        operationId,
        operationToken,
        requestId,
        assetPath,
        routeId: session.routeId,
        installationId: session.installationId,
        projectId: session.projectId,
        user: { id: session.sub, locale: session.locale, permissions: session.permissions },
      }, 30_000);
      assertRpcValueBudget(result, this.valueBudget);
      let parsed: ReturnType<typeof uiAssetOutput.parse>;
      try {
        parsed = uiAssetOutput.parse(result);
      } catch (error) {
        throw publicError(`plugin UI asset output is invalid: ${(error as Error).message}`, 502, "plugin_ui_invalid_output");
      }
      if (parsed.contentType !== descriptor.contentType) {
        throw publicError("plugin UI asset content type differs from its manifest", 502, "plugin_ui_invalid_output");
      }
      if (await sha256BytesHex(parsed.body) !== descriptor.sha256) {
        throw publicError("plugin UI asset bytes differ from its manifest hash", 502, "plugin_ui_invalid_output");
      }
      await this.sealOperation(operationId);
      await this.assertUiSessionCurrent(session);
      return parsed;
    } finally {
      this.finishOperation(operationId);
    }
  }

  private async callUi(session: PluginUiSession, method: "ui.render" | "ui.handleAction", input: { requestId: string; params: Record<string, string | number | boolean>; action?: unknown }): Promise<unknown> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    try {
      assertRpcValueBudget(input, this.valueBudget);
    } catch (error) {
      throw publicError(`plugin UI input is too large: ${(error as Error).message}`, 400, "plugin_ui_invalid_input");
    }
    await this.assertUiSessionCurrent(session);
    const manifest = this.getManifest(session.pluginId, session.pluginVersion);
    if (!manifest?.ui?.routes.some((route) => route.id === session.routeId)) throw new Error("plugin UI route is not declared");
    const { connection } = this.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.registerOperation(operationId, {
      kind: "ui",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: session.installationId,
      projectId: session.projectId,
      pluginId: session.pluginId,
      pluginVersion: session.pluginVersion,
      userId: session.sub,
      deadline: performance.now() + 30_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    try {
      let result: unknown;
      try {
        result = await connection.request(method, {
          operationId,
          operationToken,
          requestId: input.requestId,
          routeId: session.routeId,
          installationId: session.installationId,
          projectId: session.projectId,
          user: { id: session.sub, locale: session.locale, permissions: session.permissions },
          params: input.params,
          ...(method === "ui.handleAction" ? { action: input.action } : {}),
        }, 30_000);
        try {
          assertRpcValueBudget(result, this.valueBudget);
        } catch (error) {
          throw new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/INVALID_PLUGIN_OUTPUT/.test(message)) throw publicError(message, 502, "plugin_ui_invalid_output");
        throw error;
      }
      let parsed: ReturnType<typeof uiRenderOutput.parse> | ReturnType<typeof uiActionOutput.parse>;
      try {
        parsed = method === "ui.render" ? uiRenderOutput.parse(result) : uiActionOutput.parse(result);
      } catch (error) {
        throw publicError(`plugin UI output is invalid: ${(error as Error).message}`, 502, "plugin_ui_invalid_output");
      }
      await this.sealOperation(operationId);
      // Do not return a page rendered from a snapshot that was disabled or
      // migrated while the plugin call was in flight.
      await this.assertUiSessionCurrent(session);
      return parsed;
    } finally {
      this.finishOperation(operationId);
    }
  }

  private async assertUiSessionCurrent(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    observedInstallation?: { projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },
  ): Promise<void> {
    const [installation, membership] = await Promise.all([
      observedInstallation ?? this.options.prisma!.pluginInstallation.findUnique({
        where: { id: session.installationId },
        select: {
          projectId: true,
          pluginId: true,
          pluginVersion: true,
          manifestHash: true,
          state: true,
        },
      }),
      this.options.prisma!.userProject.findUnique({
        where: { userId_projectId: { userId: session.sub, projectId: session.projectId } },
        select: { userId: true },
      }),
    ]);
    if (
      !installation ||
      !membership ||
      installation.state !== "enabled" ||
      installation.projectId !== session.projectId ||
      installation.pluginId !== session.pluginId ||
      installation.pluginVersion !== session.pluginVersion ||
      installation.manifestHash.trim() !== session.manifestHash
    ) {
      throw publicError("plugin UI session is no longer valid", 403, "plugin_ui_session_invalid");
    }
  }

  private connectionFor(pluginId: string): PluginConnection {
    let connection = this.connections.get(pluginId);
    if (connection) return connection;
    const handlers: ReverseHandlers = {
      entityGet: this.options.reverseHandlers?.entityGet ?? ((input, signal, connectionId) => this.reverseEntityGet(input, signal, connectionId)),
      commandEnqueue: this.options.reverseHandlers?.commandEnqueue ?? ((input, signal, connectionId) => this.reverseCommandEnqueue(input, signal, connectionId)),
      pluginCall: this.options.reverseHandlers?.pluginCall ?? ((input, signal, connectionId) => this.reversePluginCall(input, signal, connectionId)),
      uiGetData: this.options.reverseHandlers?.uiGetData ?? unavailable,
      executionGet: this.options.reverseHandlers?.executionGet ?? ((input, signal, connectionId) => this.reverseExecutionGet(input, signal, connectionId)),
      executionRenewLease: this.options.reverseHandlers?.executionRenewLease ?? ((input, signal, connectionId) => this.reverseExecutionRenewLease(input, signal, connectionId)),
      executionRelease: this.options.reverseHandlers?.executionRelease ?? ((input, signal, connectionId) => this.reverseExecutionRelease(input, signal, connectionId)),
      executionComplete: this.options.reverseHandlers?.executionComplete ?? ((input, signal, connectionId) => this.reverseExecutionComplete(input, signal, connectionId)),
      deviceEnqueue: this.options.reverseHandlers?.deviceEnqueue ?? ((input, signal, connectionId) => this.reverseDeviceEnqueue(input, signal, connectionId)),
      deviceGet: this.options.reverseHandlers?.deviceGet ?? ((input, signal, connectionId) => this.reverseDeviceGet(input, signal, connectionId)),
      deviceCancel: this.options.reverseHandlers?.deviceCancel ?? ((input, signal, connectionId) => this.reverseDeviceCancel(input, signal, connectionId)),
    };
    const config: PluginConnectionOptions = {
      pluginId,
      endpoint: this.options.endpoints.get(pluginId)!,
      authToken: this.options.authToken,
      maxFrameBytes: this.options.maxFrameBytes,
      maxPendingRequests: this.options.maxPendingRequests,
      backpressureBytes: this.options.backpressureBytes,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
      connectTimeoutMs: this.options.connectTimeoutMs,
      reverseHandlers: handlers,
      onDisconnect: (connectionId) => {
        for (const [operationId, operation] of this.operations) {
          if (operation.connectionId === connectionId) this.finishOperation(operationId);
        }
        this.scheduleReconnect(pluginId);
      },
    };
    connection = new PluginConnection(config);
    this.connections.set(pluginId, connection);
    return connection;
  }

  private assertConfigurationBudget(config: unknown): void {
    try {
      assertRpcValueBudget(config, this.valueBudget);
    } catch (error) {
      throw publicError(`plugin configuration is too large: ${(error as Error).message}`, 400, "invalid_request");
    }
  }

  private async connect(pluginId: string): Promise<void> {
    if (this.stopping) return;
    const connection = this.connectionFor(pluginId);
    try {
      const handshake = await connection.connect();
      assertRpcValueBudget(handshake, this.valueBudget);
      const manifest = validateManifest(handshake.manifest);
      const computed = await sha256Hex(canonicalJson(manifest));
      if (computed !== handshake.manifestHash) throw new Error(`manifest hash mismatch for ${pluginId}`);
      if (manifest.id !== pluginId || manifest.version !== handshake.pluginVersion) throw new Error(`manifest identity mismatch for ${pluginId}`);
      const previous = this.options.manifestStore
        ? await this.options.manifestStore.get(manifest.id, manifest.version)
        : this.catalog.get(`${manifest.id}@${manifest.version}`);
      if (previous && previous.manifestHash !== computed) throw new Error(`manifest drift for ${manifest.id}@${manifest.version}`);
      if (!previous && this.options.manifestStore) {
        const persisted = await this.options.manifestStore.insert({ pluginId: manifest.id, pluginVersion: manifest.version, manifestHash: computed, apiVersion: manifest.apiVersion, manifest });
        if (persisted.manifestHash !== computed) throw new Error(`manifest drift for ${manifest.id}@${manifest.version}`);
      }
      this.catalog.set(`${manifest.id}@${manifest.version}`, { pluginId: manifest.id, pluginVersion: manifest.version, manifestHash: computed, manifest, connected: true });
      this.log("plugin connected", { pluginId, version: manifest.version, manifestHash: computed });
    } catch (error) {
      this.log("plugin unavailable", { pluginId, error: (error as Error).message });
      connection.disconnect("handshake rejected");
      this.scheduleReconnect(pluginId);
    }
  }

  private scheduleReconnect(pluginId: string): void {
    if (this.stopping || this.timers.has(pluginId)) return;
    const delay = Math.max(1, Math.round(this.options.reconnectMs * (0.8 + Math.random() * 0.4)));
    const timer = setTimeout(() => { this.timers.delete(pluginId); void this.connect(pluginId); }, delay);
    timer.unref?.(); this.timers.set(pluginId, timer);
  }

  private consumeEvents(): void {
    if (this.stopping || this.eventPollRunning || !this.options.eventStore) return;
    const running = this.consumeEventBatch();
    this.eventPollRunning = running;
    void running.finally(() => {
      if (this.eventPollRunning === running) this.eventPollRunning = null;
    });
  }

  private async consumeEventBatch(): Promise<void> {
    try {
      const events = await this.options.eventStore!.lease(
        this.options.eventBatchSize ?? 32,
        this.options.eventLeaseMs ?? 60_000,
      );
      const pending = new Map(events.map((event) => [event.id, { id: event.id, leaseToken: event.lease_token }]));
      const leaseMs = this.options.eventLeaseMs ?? 60_000;
      let renewal: Promise<void> | null = null;
      const renewTimer = this.options.eventStore!.renew && pending.size > 0
        ? setInterval(() => {
            if (renewal) return;
            const leases = [...pending.values()];
            if (leases.length === 0) return;
            const running = this.options.eventStore!.renew!(leases, leaseMs)
              .then(() => undefined)
              .catch((error) => {
                this.log("event lease renewal failed", { count: leases.length, error: (error as Error).message });
              });
            renewal = running;
            void running.finally(() => { if (renewal === running) renewal = null; });
          }, Math.max(100, Math.floor(leaseMs / 3)))
        : null;
      renewTimer?.unref?.();
      try {
        const groups = new Map<string, LeasedPluginEvent[]>();
        for (const event of events) {
          const group = groups.get(event.installation_id);
          if (group) group.push(event);
          else groups.set(event.installation_id, [event]);
        }
        const queue = [...groups.values()];
        let nextGroup = 0;
        const consumeGroup = async (): Promise<void> => {
          while (nextGroup < queue.length) {
            const group = queue[nextGroup++]!;
            for (const event of group) {
              try {
                if (this.stopping) await this.releaseEvent(event, false, "plugin manager is shutting down", false);
                else await this.dispatchEvent(event);
              } finally {
                pending.delete(event.id);
              }
            }
          }
        };
        const concurrency = Math.min(queue.length, this.options.eventMaxConcurrency ?? 4);
        await Promise.all(Array.from({ length: concurrency }, consumeGroup));
      } finally {
        if (renewTimer) clearInterval(renewTimer);
        if (renewal) await renewal;
      }
    } catch (error) {
      this.log("event poll failed", { error: (error as Error).message });
    }
  }

  private async dispatchEvent(event: LeasedPluginEvent): Promise<void> {
    const store = this.options.eventStore!;
    const circuitKey = `${event.plugin_id}\u0000${event.installation_id}`;
    if (!this.circuitAllows(circuitKey)) {
      await this.releaseEvent(event, false, "plugin circuit is open", false);
      return;
    }
    const connection = this.connections.get(event.plugin_id);
    const connectedManifest = connection?.manifest;
    if (
      !connection?.isOpen ||
      connectedManifest?.pluginVersion !== event.plugin_version ||
      connectedManifest.manifestHash !== event.manifest_hash.trim()
    ) {
      this.circuitFailure(circuitKey);
      await this.releaseEvent(event, false, "matching plugin version is unavailable", false);
      return;
    }
    let activeOperationId: string | undefined;
    let pluginCallCompleted = false;
    try {
      const manifestEntry = this.catalog.get(`${event.plugin_id}@${event.plugin_version}`);
      if (!manifestEntry) throw Object.assign(new Error("plugin manifest snapshot is unavailable"), { code: "MANAGER_STATE_UNAVAILABLE" });
      if (manifestEntry.manifestHash !== event.manifest_hash.trim()) {
        const error = `plugin manifest hash drift for ${event.plugin_id}@${event.plugin_version}`;
        await this.releaseEvent(event, true, error);
        return;
      }
      const eventDescriptor = manifestEntry.manifest.events.find((item) => item.kind === event.kind && item.schemaVersion === event.schema);
      if (!eventDescriptor) {
        const error = `event ${event.kind}@${event.schema} is not declared by the plugin manifest`;
        await this.releaseEvent(event, true, error);
        return;
      }
      const profile = manifestEntry.manifest.profiles.find((item) =>
        item.id === event.profile_id && item.version === event.profile_version,
      );
      if (!profile) {
        throw Object.assign(new Error(`persisted profile ${event.profile_id}@${event.profile_version} is not in the manifest snapshot`), {
          code: "MANAGER_DATA_CORRUPTION",
        });
      }
      const envelope = (() => {
        try {
          return decodeDeviceEvent(event.payload);
        } catch (error) {
          throw Object.assign(new Error(`persisted event payload is corrupt: ${(error as Error).message}`), { code: "MANAGER_DATA_CORRUPTION" });
        }
      })();
      try {
        assertRpcValueBudget([envelope.data, event.installation_config], this.valueBudget);
      } catch (error) {
        throw Object.assign(new Error(`INVALID_EVENT_INPUT: ${(error as Error).message}`), { code: "INVALID_EVENT_INPUT" });
      }
      const operationId = crypto.randomUUID();
      const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      this.registerOperation(operationId, {
        kind: "event",
        operationTokenHash: hashOperationToken(operationToken),
        connectionId: connection.id,
        installationId: event.installation_id,
        projectId: event.project_id,
        pluginId: event.plugin_id,
        pluginVersion: event.plugin_version,
        manifestHash: event.manifest_hash.trim(),
        deviceId: event.device_id,
        profileId: event.profile_id,
        profileVersion: event.profile_version,
        deadline: performance.now() + (this.options.eventTimeoutMs ?? 30_000),
        state: "active",
        reverseCalls: 0,
        inFlightReverseCalls: 0,
        stagedCommandCount: 0,
        stagedCommandBytes: 0,
        reverseSettledWaiters: new Set(),
      });
      activeOperationId = operationId;
      const execution = await this.executionForEvent(event);
      const result = await connection.request("plugin.handleEvent", {
        operationId,
        operationToken,
        event: {
          id: event.event_id.trim(),
          seq: BigInt(event.seq),
          kind: envelope.kind,
          schema: envelope.schema,
          receivedAt: event.received_at.toISOString(),
          payload: envelope.data,
        },
        installation: {
          id: event.installation_id,
          projectId: event.project_id,
          pluginId: event.plugin_id,
          pluginVersion: event.plugin_version,
          config: event.installation_config,
        },
        device: {
          id: event.device_id,
          uid: event.device_uid,
          profileId: event.profile_id,
          profileVersion: event.profile_version,
        },
        ...(execution ? { execution } : {}),
      }, this.options.eventTimeoutMs ?? 30_000);
      let output: ReturnType<typeof eventOutput.parse>;
      try {
        assertRpcValueBudget(result, this.valueBudget);
        output = eventOutput.parse(result);
      } catch (error) {
        throw Object.assign(new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`), { code: "INVALID_PLUGIN_OUTPUT" });
      }
      await this.sealOperation(operationId);
      const updates: EntityUpdateInput[] = await Promise.all((output.updates ?? []).map(async (update) => ({
        ...update,
        value: update.value instanceof Blob
          ? new Uint8Array(await update.value.arrayBuffer())
          : update.value,
      })));
      try {
        validateEntityUpdates(profile.entities, updates);
      } catch (error) {
        throw Object.assign(new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`), { code: "INVALID_PLUGIN_OUTPUT" });
      }
      pluginCallCompleted = true;
      // The breaker measures plugin/transport health, not the later database
      // commit. A responsive, valid plugin closes a half-open probe here.
      this.circuitSuccess(circuitKey);
      for (const entry of output.logs ?? []) {
        this.log("plugin event log", { pluginId: event.plugin_id, eventId: event.event_id.trim(), level: entry.level, message: entry.message });
      }
      if (store.completeWithUpdates) {
        const operation = activeOperationId ? this.operations.get(activeOperationId) : undefined;
        const completed = await store.completeWithUpdates(event.id, event.lease_token, {
          installationId: event.installation_id,
          deviceId: event.device_id,
          pluginId: event.plugin_id,
          pluginVersion: event.plugin_version,
          manifestHash: event.manifest_hash.trim(),
          profileId: event.profile_id,
          profileVersion: event.profile_version,
          snapshotDescriptors: profile.entities,
          updates,
          commands: operation?.stagedCommands,
        });
        if (!completed) {
          this.log("event completion skipped after lease loss", { eventId: event.id });
          return;
        }
      } else {
        const operation = activeOperationId ? this.operations.get(activeOperationId) : undefined;
        if (operation?.stagedCommands?.length) throw new Error("event command intents require transactional completion");
        if (!(await store.complete(event.id, event.lease_token))) {
          this.log("event completion skipped after lease loss", { eventId: event.id });
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT" || code === "MANAGER_DATA_CORRUPTION" || /INVALID_(EVENT_INPUT|PLUGIN_OUTPUT)/.test(message);
      const managerDeferral = code === "MANAGER_OVERLOADED" || code === "MANAGER_STATE_UNAVAILABLE" || code === "MANAGER_DEPENDENCY_UNAVAILABLE";
      // Manager-capacity/catalog deferrals are not delivery attempts. A
      // failed database commit after a valid plugin response still needs a
      // finite retry budget, but it must not count against plugin health.
      const consumeAttempt = permanent || !managerDeferral;
      const attemptsExhausted = !permanent && consumeAttempt && event.attempt_count >= (this.options.eventMaxAttempts ?? 5);
      if (!permanent && !pluginCallCompleted && !managerDeferral) this.circuitFailure(circuitKey);
      else this.circuitReleaseProbe(circuitKey);
      await this.releaseEvent(event, permanent || attemptsExhausted, attemptsExhausted ? `${message}; retry limit exhausted` : message, consumeAttempt);
    } finally {
      // Operation capabilities are valid only while the parent RPC is live.
      if (activeOperationId) this.finishOperation(activeOperationId);
    }
  }

  private acquireOperation(input: { operationId: string; operationToken: string }, connectionId: string): ActiveOperation {
    const operation = this.operations.get(input.operationId);
    const suppliedHash = hashOperationToken(input.operationToken);
    if (!operation || operation.connectionId !== connectionId || !timingSafeEqual(operation.operationTokenHash, suppliedHash)) {
      throw new Error("operation capability is invalid or expired");
    }
    if (operation.state !== "active" || performance.now() >= operation.deadline) throw new Error("operation capability is sealed or expired");
    if (operation.reverseCalls >= (this.options.maxReverseCallsPerOperation ?? 64)) throw new Error("operation reverse call limit exceeded");
    const pluginInFlight = this.reverseInFlightByPlugin.get(operation.pluginId) ?? 0;
    const installationInFlight = this.reverseInFlightByInstallation.get(operation.installationId) ?? 0;
    if (
      this.reverseInFlight >= (this.options.maxReverseConcurrency ?? 256) ||
      pluginInFlight >= (this.options.maxReverseConcurrencyPerPlugin ?? 64) ||
      installationInFlight >= (this.options.maxReverseConcurrencyPerInstallation ?? 16)
    ) {
      throw new Error("reverse RPC concurrency limit exceeded");
    }
    operation.reverseCalls += 1;
    operation.inFlightReverseCalls += 1;
    this.reverseInFlight += 1;
    this.reverseInFlightByPlugin.set(operation.pluginId, pluginInFlight + 1);
    this.reverseInFlightByInstallation.set(operation.installationId, installationInFlight + 1);
    return operation;
  }

  private cacheExecutionCapability(execution: DebugExecutionRecord, token: string): void {
    const expiresAt = Date.parse(execution.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const previous = this.executionByDevice.get(executionScopeKey(execution.installationId, execution.deviceId));
    if (previous && previous !== execution.id) this.executionTokens.delete(previous);
    this.executionTokens.set(execution.id, {
      installationId: execution.installationId,
      deviceId: execution.deviceId,
      token,
      expiresAt,
    });
    this.executionByDevice.set(executionScopeKey(execution.installationId, execution.deviceId), execution.id);
  }

  private forgetExecutionDeviceScope(executionId: string): void {
    const cached = this.executionTokens.get(executionId);
    if (!cached) return;
    const key = executionScopeKey(cached.installationId, cached.deviceId);
    if (this.executionByDevice.get(key) === executionId) this.executionByDevice.delete(key);
  }

  private forgetExecutionCapability(executionId: string): void {
    this.forgetExecutionDeviceScope(executionId);
    this.executionTokens.delete(executionId);
  }

  private pruneExecutionCapabilities(): void {
    const now = Date.now();
    for (const [executionId, cached] of this.executionTokens) {
      if (cached.expiresAt <= now) this.forgetExecutionCapability(executionId);
    }
  }

  /**
   * Attach a capability only when the event belongs to the currently leased
   * execution for the same installation/device.  The in-memory token is
   * checked against the database hash and lifecycle state on every event, so
   * disabling, rebinding, expiry, or lease release immediately removes the
   * device-command capability even if a queued event is still being drained.
   */
  private async executionForEvent(event: LeasedPluginEvent): Promise<{ executionId: string; executionToken: string } | null> {
    if (!this.options.prisma) return null;
    const executionId = this.executionByDevice.get(executionScopeKey(event.installation_id, event.device_id));
    if (!executionId) return null;
    const cached = this.executionTokens.get(executionId);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.forgetExecutionCapability(executionId);
      return null;
    }
    const execution = await getDebugExecutionCapability(this.options.prisma, executionId, hashCapabilityToken(cached.token));
    if (
      !execution ||
      execution.state !== "active" ||
      !execution.deviceLeaseExpiresAt ||
      Date.parse(execution.deviceLeaseExpiresAt) <= Date.now() ||
      execution.installationId !== event.installation_id ||
      execution.deviceId !== event.device_id ||
      execution.pluginId !== event.plugin_id ||
      execution.pluginVersion !== event.plugin_version ||
      execution.manifestHash !== event.manifest_hash.trim()
    ) {
      this.forgetExecutionCapability(executionId);
      return null;
    }
    return { executionId, executionToken: cached.token };
  }

  private registerOperation(operationId: string, operation: ActiveOperation): void {
    const pluginCount = this.operationsByPlugin.get(operation.pluginId) ?? 0;
    const installationCount = this.operationsByInstallation.get(operation.installationId) ?? 0;
    if (
      this.operations.size >= (this.options.maxOperations ?? 256) ||
      pluginCount >= (this.options.maxOperationsPerPlugin ?? 64) ||
      installationCount >= (this.options.maxOperationsPerInstallation ?? 32)
    ) {
      throw Object.assign(new Error("plugin manager operation limit reached"), {
        code: "MANAGER_OVERLOADED",
        status: 503,
        publicCode: "plugin_manager_overloaded",
      });
    }
    this.operations.set(operationId, operation);
    this.operationsByPlugin.set(operation.pluginId, pluginCount + 1);
    this.operationsByInstallation.set(operation.installationId, installationCount + 1);
  }

  private finishOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    this.operations.delete(operationId);
    decrementCounter(this.operationsByPlugin, operation.pluginId);
    decrementCounter(this.operationsByInstallation, operation.installationId);
  }

  private releaseOperation(operation: ActiveOperation): void {
    operation.inFlightReverseCalls -= 1;
    this.reverseInFlight -= 1;
    decrementCounter(this.reverseInFlightByPlugin, operation.pluginId);
    decrementCounter(this.reverseInFlightByInstallation, operation.installationId);
    if (operation.inFlightReverseCalls === 0) {
      for (const resolve of operation.reverseSettledWaiters) resolve();
      operation.reverseSettledWaiters.clear();
    }
  }

  private async sealOperation(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error("operation connection closed before completion");
    operation.state = "sealed";
    if (operation.inFlightReverseCalls === 0) return;
    const remaining = Math.min(250, Math.max(0, operation.deadline - performance.now()));
    if (remaining === 0) throw new Error("operation expired while reverse calls were active");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => operation.reverseSettledWaiters.add(resolve)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("operation reverse calls did not settle during cleanup grace")), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async reversePluginCall(input: PluginCallInput, signal: AbortSignal, connectionId: string): Promise<unknown> {
    if (signal.aborted) throw new Error("operation aborted");
    const source = this.acquireOperation(input, connectionId);
    let targetOperationId: string | undefined;
    try {
      if (input.pluginId === source.pluginId) throw new Error("plugin-to-plugin calls cannot target the caller plugin");
      const maxDepth = this.options.maxPluginCallDepth ?? 4;
      const depth = source.pluginCallDepth ?? 0;
      if (depth >= maxDepth) throw new Error("plugin-to-plugin call depth limit exceeded");
      assertRpcValueBudget(input.input, this.valueBudget);
      const targetConnection = this.connections.get(input.pluginId);
      const targetHandshake = targetConnection?.manifest;
      if (!targetConnection?.isOpen || !targetHandshake) {
        throw Object.assign(new Error("target plugin is unavailable"), { code: "MANAGER_DEPENDENCY_UNAVAILABLE" });
      }
      const targetManifest = this.catalog.get(`${input.pluginId}@${targetHandshake.pluginVersion}`);
      if (!targetManifest || targetManifest.manifestHash !== targetHandshake.manifestHash) {
        throw Object.assign(new Error("target plugin manifest is unavailable"), { code: "MANAGER_DEPENDENCY_UNAVAILABLE" });
      }
      const remaining = Math.floor(Math.min(30_000, source.deadline - performance.now()));
      if (remaining < 1) throw new Error("operation expired");
      targetOperationId = crypto.randomUUID();
      const targetToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      this.registerOperation(targetOperationId, {
        kind: "plugin-call",
        operationTokenHash: hashOperationToken(targetToken),
        connectionId: targetConnection.id,
        installationId: source.installationId,
        projectId: source.projectId,
        pluginId: input.pluginId,
        pluginVersion: targetHandshake.pluginVersion,
        manifestHash: targetHandshake.manifestHash,
        deviceId: source.deviceId,
        userId: source.userId,
        pluginCallDepth: depth + 1,
        deadline: performance.now() + remaining,
        state: "active",
        reverseCalls: 0,
        inFlightReverseCalls: 0,
        stagedCommandCount: 0,
        stagedCommandBytes: 0,
        reverseSettledWaiters: new Set(),
      });
      const result = await targetConnection.request("plugin.call", {
        operationId: targetOperationId,
        operationToken: targetToken,
        caller: {
          pluginId: source.pluginId,
          pluginVersion: source.pluginVersion,
          projectId: source.projectId,
          installationId: source.installationId,
          ...(source.deviceId ? { deviceId: source.deviceId } : {}),
          ...(source.userId ? { userId: source.userId } : {}),
        },
        procedure: input.procedure,
        input: input.input,
      }, remaining);
      assertRpcValueBudget(result, this.valueBudget);
      await this.sealOperation(targetOperationId);
      return result;
    } finally {
      if (targetOperationId) this.finishOperation(targetOperationId);
      this.releaseOperation(source);
    }
  }

  private async reverseEntityGet(input: EntityGetInput, signal: AbortSignal, connectionId: string) {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (operation.kind !== "event") throw new Error("entity read is not allowed for this operation");
      if (!operation.deviceId) throw new Error("entity read requires a device scope");
      if (!operation.profileId || operation.profileVersion === undefined || !operation.manifestHash) {
        throw new Error("entity read requires an event snapshot");
      }
      if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
      const state = await getPluginEntityState(this.options.prisma, {
        installationId: operation.installationId,
        deviceId: operation.deviceId,
        pluginId: operation.pluginId,
        pluginVersion: operation.pluginVersion,
        manifestHash: operation.manifestHash,
        profileId: operation.profileId,
        profileVersion: operation.profileVersion,
      }, input.entityKey);
      if (!state) return null;
      const value = state.value instanceof Uint8Array ? new Blob([state.value]) : state.value;
      return { ...state, value };
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async executionForOperation(
    input: { executionId: string; executionToken: string },
    operation: ActiveOperation,
    capability: string,
  ): Promise<{ execution: DebugExecutionRecord; tokenHash: string }> {
    if (!this.options.prisma) throw new Error("plugin execution RPC is not configured");
    const tokenHash = hashCapabilityToken(input.executionToken);
    const execution = await getDebugExecutionCapability(this.options.prisma, input.executionId, tokenHash);
    if (!execution ||
      execution.installationId !== operation.installationId ||
      execution.pluginId !== operation.pluginId ||
      execution.pluginVersion !== operation.pluginVersion ||
      (operation.deviceId !== undefined && execution.deviceId !== operation.deviceId)) {
      throw new Error("debug execution capability is outside the operation scope");
    }
    if (!execution.allowedCapabilities.includes(capability)) {
      throw new Error(`debug execution capability ${capability} is not granted`);
    }
    return { execution, tokenHash };
  }

  private async reverseExecutionGet(input: ExecutionGetInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      return (await this.executionForOperation(input, operation, "execution.get")).execution;
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseExecutionRenewLease(input: ExecutionRenewLeaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "execution.renew_lease");
      return renewDebugExecutionLease(this.options.prisma!, execution.id, tokenHash, input.leaseMs);
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseExecutionRelease(input: ExecutionReleaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "execution.release");
      const result = await releaseDebugExecution(this.options.prisma!, execution.id, tokenHash);
      this.forgetExecutionDeviceScope(execution.id);
      return result;
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseExecutionComplete(input: ExecutionCompleteInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "execution.complete");
      const result = await completeDebugExecution(this.options.prisma!, execution.id, tokenHash, input.state);
      this.forgetExecutionCapability(execution.id);
      return result;
    } finally {
      this.releaseOperation(operation);
    }
  }

  private assertExecutionCommandAllowed(operation: ActiveOperation, command: string, args: readonly CommandArgument[]): void {
    const invalidCode = operation.kind === "event" ? "INVALID_EVENT_INPUT" : "INVALID_EXECUTION_INPUT";
    const manifest = this.getManifest(operation.pluginId, operation.pluginVersion);
    const actions = manifest?.actions.filter((action) => action.wire.command === command) ?? [];
    if (actions.length === 0) {
      throw Object.assign(new Error(`execution command ${command} is not declared by the plugin manifest`), { code: invalidCode });
    }
    if (actions.some((action) => action.requiresHumanApproval)) {
      throw Object.assign(new Error(`execution command ${command} requires human approval`), { code: invalidCode });
    }
    let actionInput: Record<string, unknown>;
    try {
      actionInput = commandArgumentsToActionInput(args);
    } catch (error) {
      throw Object.assign(new Error(`execution command ${command} arguments are malformed: ${(error as Error).message}`), { code: invalidCode });
    }
    if (!actions.some((action) => validateActionInput(action.inputSchema, actionInput).ok)) {
      throw Object.assign(new Error(`execution command ${command} arguments do not match the plugin action schema`), { code: invalidCode });
    }
  }

  private async reverseDeviceEnqueue(input: DeviceEnqueueInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (!this.options.prisma) throw new Error("plugin device RPC is not configured");
      assertRpcValueBudget(input.args, this.valueBudget);
      const args = await normalizeCommandArguments(input.args);
      this.assertExecutionCommandAllowed(operation, input.command, args);
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "device.enqueue_command");
      return await enqueueDebugCommand(this.options.prisma, {
        executionId: execution.id,
        tokenHash,
        pluginId: operation.pluginId,
        pluginVersion: operation.pluginVersion,
        manifestHash: execution.manifestHash,
        initiatingUserId: execution.initiatingUserId,
        command: { cmd: input.command, args },
        correlationId: execution.id,
        idempotencyKey: input.idempotencyKey,
      });
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseDeviceGet(input: DeviceGetInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput | null> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (!this.options.prisma) throw new Error("plugin device RPC is not configured");
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "device.get_command");
      return getDebugCommand(this.options.prisma, execution.id, tokenHash, input.commandId);
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseDeviceCancel(input: DeviceCancelInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (!this.options.prisma) throw new Error("plugin device RPC is not configured");
      const { execution, tokenHash } = await this.executionForOperation(input, operation, "device.cancel_command");
      return requestDebugCommandCancellation(this.options.prisma, execution.id, tokenHash, input.commandId);
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseCommandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    let reservation = 0;
    let reserved = false;
    try {
      if (operation.kind !== "event") throw new Error("command enqueue is not allowed for this operation");
      if (!operation.deviceId) throw new Error("command enqueue requires a device scope");
      if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
      assertRpcValueBudget(input.args, this.valueBudget);
      const args = await normalizeCommandArguments(input.args);
      reservation = commandIntentBytes(input.command, input.args);
      if (operation.stagedCommandCount >= (this.options.maxStagedCommands ?? 32)) {
        throw new Error("operation command intent limit exceeded");
      }
      if (operation.stagedCommandBytes + reservation > (this.options.maxStagedCommandBytes ?? 256 * 1024)) {
        throw new Error("operation command intent byte limit exceeded");
      }
      this.assertExecutionCommandAllowed(operation, input.command, args);
      operation.stagedCommandCount += 1;
      operation.stagedCommandBytes += reservation;
      reserved = true;
      const binding = await this.options.prisma.pluginDeviceBinding.findUnique({
        where: { deviceId: operation.deviceId },
        select: { installationId: true, installation: { select: { state: true, projectId: true } } },
      });
      if (!binding || binding.installationId !== operation.installationId || binding.installation.projectId !== operation.projectId || binding.installation.state !== "enabled") {
        throw new Error("device is not bound to the active plugin installation");
      }
      operation.stagedCommands ??= [];
      operation.stagedCommands.push({ deviceId: operation.deviceId, command: { cmd: input.command, args } });
      return { accepted: true };
    } catch (error) {
      if (reserved) {
        operation.stagedCommandCount -= 1;
        operation.stagedCommandBytes -= reservation;
      }
      throw error;
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async releaseEvent(event: LeasedPluginEvent, permanent: boolean, message: string, consumeAttempt = true): Promise<void> {
    const retryMs = permanent ? 0 : Math.min(60_000, 1_000 * 2 ** Math.min(event.attempt_count, 6));
    try {
      await this.options.eventStore!.release(event.id, event.lease_token, permanent, message.slice(0, 2_000), retryMs, consumeAttempt);
    } catch (error) {
      this.log("event lease release failed", { eventId: event.id, error: (error as Error).message });
    }
  }

  private circuitAllows(key: string): boolean {
    const circuit = this.circuits.get(key);
    if (!circuit) return true;
    const now = Date.now();
    if (!circuit.probeInProgress && now - (circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_IDLE_RETENTION_MS) {
      this.circuits.delete(key);
      return true;
    }
    circuit.lastTouchedAt = now;
    if (circuit.failures < 5) return true;
    if (now - circuit.openedAt < 30_000) return false;
    if (circuit.probeInProgress) return false;
    circuit.probeInProgress = true;
    return true;
  }

  private circuitFailure(key: string): void {
    const now = Date.now();
    const circuit = this.circuits.get(key) ?? { failures: 0, openedAt: 0, probeInProgress: false, lastTouchedAt: now };
    circuit.failures += 1;
    circuit.probeInProgress = false;
    circuit.lastTouchedAt = now;
    if (circuit.failures >= 5) circuit.openedAt = now;
    this.circuits.set(key, circuit);
  }

  private circuitSuccess(key: string): void {
    this.circuits.delete(key);
  }

  private circuitReleaseProbe(key: string): void {
    const circuit = this.circuits.get(key);
    if (circuit) {
      circuit.probeInProgress = false;
      circuit.lastTouchedAt = Date.now();
    }
  }

  private pruneCircuits(now = Date.now()): void {
    for (const [key, circuit] of this.circuits) {
      if (!circuit.probeInProgress && now - (circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_IDLE_RETENTION_MS) {
        this.circuits.delete(key);
      }
    }
  }

  listCatalog(): CatalogEntry[] {
    return [...this.catalog.values()].map((entry) => {
      const connection = this.connections.get(entry.pluginId);
      const handshake = connection?.manifest;
      return {
        ...entry,
        connected: connection?.isOpen === true && handshake?.pluginVersion === entry.pluginVersion && handshake.manifestHash === entry.manifestHash,
      };
    });
  }
  getConnection(pluginId: string): PluginConnection | undefined { return this.connections.get(pluginId); }
  getManifest(pluginId: string, version: string): PluginManifest | undefined { return this.catalog.get(`${pluginId}@${version}`)?.manifest; }

  async ready(): Promise<boolean> {
    if (!this.options.prisma) return false;
    try {
      await this.options.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private requireConnectedManifest(pluginId: string, pluginVersion: string, manifestHash: string): { entry: CatalogEntry; connection: PluginConnection } {
    const entry = this.catalog.get(`${pluginId}@${pluginVersion}`);
    if (!entry || entry.manifestHash !== manifestHash) throw Object.assign(new Error("plugin manifest is not deployed"), { status: 404 });
    const connection = this.connections.get(pluginId);
    const handshake = connection?.manifest;
    if (!connection?.isOpen || handshake?.pluginVersion !== pluginVersion || handshake.manifestHash !== manifestHash) {
      throw Object.assign(new Error("requested plugin version is unavailable"), { status: 503 });
    }
    return { entry, connection };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.eventPollRunning) await this.eventPollRunning;
    if (this.maintenanceRunning) await this.maintenanceRunning;
    this.executionTokens.clear();
    this.executionByDevice.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

function commandIntentBytes(command: string, args: CommandEnqueueInput["args"]): number {
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

function artifactChunkTimeout(chunkTimeoutMs: number, deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw publicError("artifact upload timed out", 504, "plugin_timeout");
  return Math.max(1, Math.min(chunkTimeoutMs, remaining));
}

async function readArtifactChunk(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, deadline: number): Promise<{ done: boolean; value?: Uint8Array }> {
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

function hashOperationToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function executionScopeKey(installationId: string, deviceId: string): string {
  return `${installationId}\u0000${deviceId}`;
}

function decrementCounter(counters: Map<string, number>, key: string): void {
  const next = (counters.get(key) ?? 1) - 1;
  if (next === 0) counters.delete(key);
  else counters.set(key, next);
}
