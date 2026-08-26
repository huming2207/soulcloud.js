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
import * as debuggerImpl from "./manager/debugger";
import * as actionsImpl from "./manager/actions";
import * as uiImpl from "./manager/ui";
import * as eventsImpl from "./manager/events";
import * as operationsImpl from "./manager/operations";
import * as executionImpl from "./manager/execution";
import * as rpcImpl from "./manager/rpc";
import * as circuitImpl from "./manager/circuit";
import { ActiveOperation, CachedExecutionCapability, PluginCircuit, publicError, unavailable } from "./manager/helpers";
export * from "./manager/helpers";
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
  /** Render deadline for one SSR/UI RPC (ui.render, ui.handleAction, ui.asset). */
  ssrTimeoutMs?: number;
  /** Independent SSR concurrency budget; a slow page must not consume the
   *  event-consumer or internal-API operation budgets. */
  ssrMaxConcurrency?: number;
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

export class PluginManager {
  readonly connections = new Map<string, PluginConnection>();
  readonly catalog = new Map<string, CatalogEntry>();
  readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly operations = new Map<string, ActiveOperation>();
  readonly operationsByPlugin = new Map<string, number>();
  readonly operationsByInstallation = new Map<string, number>();
  reverseInFlight = 0;
  readonly reverseInFlightByPlugin = new Map<string, number>();
  readonly reverseInFlightByInstallation = new Map<string, number>();
  /**
   * Raw execution tokens are intentionally process-local.  The database only
   * stores their hashes; this cache lets a device event continue an execution
   * that was started by this Manager without widening the persisted secret
   * surface.  A Manager restart safely drops the cache and therefore drops
   * event-side device capabilities until explicit recovery is implemented.
   */
  readonly executionTokens = new Map<string, CachedExecutionCapability>();
  readonly executionByDevice = new Map<string, string>();
  readonly circuits = new Map<string, PluginCircuit>();
  eventTimer: ReturnType<typeof setInterval> | null = null;
  eventPollRunning: Promise<void> | null = null;
  maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  maintenanceRunning: Promise<void> | null = null;
  stopping = false;
  /** In-flight SSR/UI RPC count guarded by options.ssrMaxConcurrency. */
  ssrInFlight = 0;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
  readonly valueBudget: RpcValueBudget;

  constructor(readonly options: PluginManagerOptions) {
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
  }): Promise<{ execution: DebugExecutionRecord; executionToken: string }>  {
    return debuggerImpl.startDebugExecutionImpl(this, input);
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
  }): Promise<{ execution: DebugExecutionRecord; sessionId: string }>  {
    return debuggerImpl.startDebugSessionImpl(this, input);
  }

  async abortDebugSessionBestEffort(input: {
    connection: PluginConnection;
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string };
    deviceId: string;
    executionId: string;
    sessionId?: string;
    userId: string;
    reason: string;
    timeoutMs: number;
  }): Promise<void>  {
    return debuggerImpl.abortDebugSessionBestEffortImpl(this, input);
  }

  async getDebugExecution(executionId: string): Promise<DebugExecutionRecord | null>  {
    return debuggerImpl.getDebugExecutionImpl(this, executionId);
  }

  async getDebugExecutionForScope(input: { executionId: string; installationId: string; projectId: string; userId: string }): Promise<DebugExecutionRecord | null>  {
    return debuggerImpl.getDebugExecutionForScopeImpl(this, input);
  }

  async listDebugCommandsForUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<ReturnType<typeof listDebugCommands>>  {
    return debuggerImpl.listDebugCommandsForUiSessionImpl(this, session, executionId);
  }

  /** Return execution lifecycle state to a scoped plugin-origin debugger page. */
  async getDebugExecutionForUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<DebugExecutionRecord>  {
    return debuggerImpl.getDebugExecutionForUiSessionImpl(this, session, executionId);
  }

  /** Request cancellation of one command from the authenticated debugger UI.
   * The initiating user and the in-memory execution capability remain
   * required; a browser cannot manufacture a cancellation token after a
   * Manager restart. */
  async cancelDebugCommandFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    commandId: string,
  ): Promise<ReturnType<typeof requestDebugCommandCancellation>>  {
    return debuggerImpl.cancelDebugCommandFromUiSessionImpl(this, session, executionId, commandId);
  }

  /** Request one device-command cancellation from the Human API user scope. */
  async cancelDebugCommandForUser(input: {
    executionId: string;
    commandId: string;
    installationId: string;
    projectId: string;
    userId: string;
  }): Promise<ReturnType<typeof requestDebugCommandCancellation>>  {
    return debuggerImpl.cancelDebugCommandForUserImpl(this, input);
  }

  /**
   * Release a debugger device lease from the authenticated plugin-origin UI.
   * The raw execution token is intentionally only available in this Manager
   * process; after a restart the UI must not be able to reconstruct it.
   */
  async releaseDebugExecutionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
  ): Promise<DebugExecutionRecord>  {
    return debuggerImpl.releaseDebugExecutionFromUiSessionImpl(this, session, executionId);
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
  }): Promise<DebugExecutionRecord>  {
    return debuggerImpl.pauseDebugExecutionForUserImpl(this, input);
  }

  /** Renew an execution lease from the same human-scoped plugin UI session. */
  async renewDebugExecutionFromUiSession(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    leaseMs: number,
  ): Promise<DebugExecutionRecord>  {
    return debuggerImpl.renewDebugExecutionFromUiSessionImpl(this, session, executionId, leaseMs);
  }

  async renewDebugExecution(executionId: string, executionToken: string, leaseMs: number): Promise<DebugExecutionRecord>  {
    return debuggerImpl.renewDebugExecutionImpl(this, executionId, executionToken, leaseMs);
  }

  async releaseDebugExecution(executionId: string, executionToken: string): Promise<DebugExecutionRecord>  {
    return debuggerImpl.releaseDebugExecutionImpl(this, executionId, executionToken);
  }

  async completeDebugExecution(executionId: string, executionToken: string, state: "completed" | "failed"): Promise<DebugExecutionRecord>  {
    return debuggerImpl.completeDebugExecutionImpl(this, executionId, executionToken, state);
  }

  async setInstallationState(installationId: string, state: "enabled" | "disabled"): Promise<void>  {
    return debuggerImpl.setInstallationStateImpl(this, installationId, state);
  }

  async migrateInstallation(installationId: string, pluginVersion: string, manifestHash: string, config: unknown): Promise<void>  {
    return debuggerImpl.migrateInstallationImpl(this, installationId, pluginVersion, manifestHash, config);
  }

  async reconcileInstallation(installationId: string): Promise<void>  {
    return debuggerImpl.reconcileInstallationImpl(this, installationId);
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
  }): Promise<{ batchId: string; deviceCount: number }>  {
    return actionsImpl.encodeActionImpl(this, input);
  }

  async configureTarget(input: {
    installationId: string;
    projectId: string;
    userId: string;
    yaml: string;
    timeoutMs?: number;
  }): Promise<{ configId: string; revision: number; sha256: string; targetCount: number }>  {
    return actionsImpl.configureTargetImpl(this, input);
  }

  async listTargetConfigs(input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ configId: string; revision: number; sha256: string; targetCount: number; createdAt: string }>>  {
    return actionsImpl.listTargetConfigsImpl(this, input);
  }

  async listArtifacts(input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ artifactId: string; kind: "elf" | "firmware"; filename: string; contentType: string; size: number; sha256: string; metadata: Record<string, string | number>; createdAt: string }>>  {
    return actionsImpl.listArtifactsImpl(this, input);
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
  }): Promise<{ artifactId: string; offset: number; totalSize: number; sha256: string; chunk: Uint8Array; final: boolean }>  {
    return actionsImpl.readArtifactChunkImpl(this, input);
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
  }): Promise<{ uploadId: string; artifactId: string; sha256: string; size: number; kind: "elf" | "firmware"; filename: string }>  {
    return actionsImpl.uploadArtifactImpl(this, input);
  }

  async assertArtifactInstallationSnapshotCurrent(
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },
    uiSession?: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
  ): Promise<void>  {
    return actionsImpl.assertArtifactInstallationSnapshotCurrentImpl(this, installation, uiSession);
  }

  async assertInstallationSnapshotCurrent(
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string },
    message: string,
    options?: { status: number; publicCode: string },
  ): Promise<void>  {
    return actionsImpl.assertInstallationSnapshotCurrentImpl(this, installation, message, options);
  }

  async sendArtifactChunk(
    connection: PluginConnection,
    input: { installation: { id: string; projectId: string; pluginId: string; pluginVersion: string }; uploadId: string; userId: string; caseId?: string; kind: "elf" | "firmware"; filename: string; contentType: string; totalSize: number; offset: number; final: boolean; chunk: Uint8Array },
    timeoutMs: number,
    expectFinal = false,
  ): Promise<number | { artifactId: string; sha256: string }>  {
    return actionsImpl.sendArtifactChunkImpl(this, connection, input, timeoutMs, expectFinal);
  }

  async renderPluginUi(session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>): Promise<unknown>  {
    return uiImpl.renderPluginUiImpl(this, session, requestId, params);
  }

  async handlePluginUiAction(session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>, action: unknown): Promise<unknown>  {
    return uiImpl.handlePluginUiActionImpl(this, session, requestId, params, action);
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
  ): Promise<{ batchId: string; deviceCount: number }>  {
    return uiImpl.encodeActionFromUiSessionImpl(this, session, input);
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
  ): Promise<{ execution: DebugExecutionRecord; sessionId: string }>  {
    return uiImpl.startDebugSessionFromUiSessionImpl(this, session, input);
  }

  async getPluginUiAsset(session: PluginUiSession, requestId: string, assetPath: string): Promise<unknown>  {
    return uiImpl.getPluginUiAssetImpl(this, session, requestId, assetPath);
  }

  async callUi(session: PluginUiSession, method: "ui.render" | "ui.handleAction", input: { requestId: string; params: Record<string, string | number | boolean>; action?: unknown }): Promise<unknown>  {
    return uiImpl.callUiImpl(this, session, method, input);
  }

  async assertUiSessionCurrent(
    session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    observedInstallation?: { projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },
  ): Promise<void>  {
    return uiImpl.assertUiSessionCurrentImpl(this, session, observedInstallation);
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

  assertConfigurationBudget(config: unknown): void {
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

  consumeEvents(): void  {
    return eventsImpl.consumeEventsImpl(this);
  }

  async consumeEventBatch(): Promise<void>  {
    return eventsImpl.consumeEventBatchImpl(this);
  }

  async dispatchEvent(event: LeasedPluginEvent): Promise<void>  {
    return eventsImpl.dispatchEventImpl(this, event);
  }

  acquireOperation(input: { operationId: string; operationToken: string }, connectionId: string): ActiveOperation  {
    return operationsImpl.acquireOperationImpl(this, input, connectionId);
  }

  cacheExecutionCapability(execution: DebugExecutionRecord, token: string): void  {
    return executionImpl.cacheExecutionCapabilityImpl(this, execution, token);
  }

  forgetExecutionDeviceScope(executionId: string): void  {
    return executionImpl.forgetExecutionDeviceScopeImpl(this, executionId);
  }

  forgetExecutionCapability(executionId: string): void  {
    return executionImpl.forgetExecutionCapabilityImpl(this, executionId);
  }

  pruneExecutionCapabilities(): void  {
    return executionImpl.pruneExecutionCapabilitiesImpl(this);
  }

  /**
   * Attach a capability only when the event belongs to the currently leased
   * execution for the same installation/device.  The in-memory token is
   * checked against the database hash and lifecycle state on every event, so
   * disabling, rebinding, expiry, or lease release immediately removes the
   * device-command capability even if a queued event is still being drained.
   */
  async executionForEvent(event: LeasedPluginEvent): Promise<{ executionId: string; executionToken: string } | null>  {
    return executionImpl.executionForEventImpl(this, event);
  }

  registerOperation(operationId: string, operation: ActiveOperation): void  {
    return operationsImpl.registerOperationImpl(this, operationId, operation);
  }

  finishOperation(operationId: string): void  {
    return operationsImpl.finishOperationImpl(this, operationId);
  }

  releaseOperation(operation: ActiveOperation): void  {
    return operationsImpl.releaseOperationImpl(this, operation);
  }

  async sealOperation(operationId: string): Promise<void>  {
    return operationsImpl.sealOperationImpl(this, operationId);
  }

  async reversePluginCall(input: PluginCallInput, signal: AbortSignal, connectionId: string): Promise<unknown>  {
    return rpcImpl.reversePluginCallImpl(this, input, signal, connectionId);
  }

  async reverseEntityGet(input: EntityGetInput, signal: AbortSignal, connectionId: string)  {
    return rpcImpl.reverseEntityGetImpl(this, input, signal, connectionId);
  }

  async executionForOperation(
    input: { executionId: string; executionToken: string },
    operation: ActiveOperation,
    capability: string,
  ): Promise<{ execution: DebugExecutionRecord; tokenHash: string }>  {
    return executionImpl.executionForOperationImpl(this, input, operation, capability);
  }

  async reverseExecutionGet(input: ExecutionGetInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput>  {
    return executionImpl.reverseExecutionGetImpl(this, input, signal, connectionId);
  }

  async reverseExecutionRenewLease(input: ExecutionRenewLeaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput>  {
    return executionImpl.reverseExecutionRenewLeaseImpl(this, input, signal, connectionId);
  }

  async reverseExecutionRelease(input: ExecutionReleaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput>  {
    return executionImpl.reverseExecutionReleaseImpl(this, input, signal, connectionId);
  }

  async reverseExecutionComplete(input: ExecutionCompleteInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput>  {
    return executionImpl.reverseExecutionCompleteImpl(this, input, signal, connectionId);
  }

  assertExecutionCommandAllowed(operation: ActiveOperation, command: string, args: readonly CommandArgument[]): void  {
    return executionImpl.assertExecutionCommandAllowedImpl(this, operation, command, args);
  }

  async reverseDeviceEnqueue(input: DeviceEnqueueInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput>  {
    return executionImpl.reverseDeviceEnqueueImpl(this, input, signal, connectionId);
  }

  async reverseDeviceGet(input: DeviceGetInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput | null>  {
    return executionImpl.reverseDeviceGetImpl(this, input, signal, connectionId);
  }

  async reverseDeviceCancel(input: DeviceCancelInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput>  {
    return executionImpl.reverseDeviceCancelImpl(this, input, signal, connectionId);
  }

  async reverseCommandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }>  {
    return executionImpl.reverseCommandEnqueueImpl(this, input, signal, connectionId);
  }

  async releaseEvent(event: LeasedPluginEvent, permanent: boolean, message: string, consumeAttempt = true): Promise<void>  {
    return eventsImpl.releaseEventImpl(this, event, permanent, message, consumeAttempt);
  }

  circuitAllows(key: string): boolean  {
    return circuitImpl.circuitAllowsImpl(this, key);
  }

  circuitFailure(key: string): void  {
    return circuitImpl.circuitFailureImpl(this, key);
  }

  circuitSuccess(key: string): void  {
    return circuitImpl.circuitSuccessImpl(this, key);
  }

  circuitReleaseProbe(key: string): void  {
    return circuitImpl.circuitReleaseProbeImpl(this, key);
  }

  pruneCircuits(now = Date.now()): void  {
    return circuitImpl.pruneCircuitsImpl(this, now);
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

  requireConnectedManifest(pluginId: string, pluginVersion: string, manifestHash: string): { entry: CatalogEntry; connection: PluginConnection } {
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
