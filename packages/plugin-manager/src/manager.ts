import { validateActionInput, validateEntityUpdates, validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import {
  DEFAULT_RPC_VALUE_BUDGET,
  assertRpcValueBudget,
  canonicalJson,
  sha256Hex,
  type CommandEnqueueInput,
  type EntityGetInput,
  type HandshakeOutput,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";
import {
  completePluginEvent,
  completePluginEventWithUpdates,
  decodeDeviceEvent,
  enqueueBatchInTransaction,
  getPluginEntityState,
  bindDeviceToPluginInstallation,
  createPluginInstallation,
  migratePluginInstallation,
  reconcilePluginInstallation,
  setPluginInstallationState,
  leasePluginEvents,
  releasePluginEvent,
  renewPluginEventLeases,
  purgePluginData,
  Prisma,
  type LeasedPluginEvent,
  type EntityUpdateInput,
  type CommandArgument,
  type DeviceCommand,
  type PluginUiSession,
  type BindDeviceInput,
  type CreateInstallationInput,
  type PrismaClient,
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
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginEventStore {
  lease(limit: number, leaseMs: number): Promise<LeasedPluginEvent[]>;
  complete(eventId: string, leaseToken: string): Promise<boolean>;
  completeWithUpdates?(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[]; commands?: readonly { deviceId: string; command: DeviceCommand }[] }): Promise<boolean>;
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number, consumeAttempt?: boolean): Promise<boolean>;
  renew?(leases: readonly { id: string; leaseToken: string }[], leaseMs: number): Promise<number>;
  purge?(eventRetentionDays: number, historyRetentionDays: number, batchSize: number): Promise<{ events: number; history: number }>;
}

export class PrismaPluginEventStore implements PluginEventStore {
  constructor(private readonly prisma: PrismaClient) {}
  lease(limit: number, leaseMs: number) { return leasePluginEvents(this.prisma, limit, leaseMs); }
  complete(eventId: string, leaseToken: string) { return completePluginEvent(this.prisma, eventId, leaseToken); }
  completeWithUpdates(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[]; commands?: readonly { deviceId: string; command: DeviceCommand }[] }) {
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

const unavailable = async (): Promise<never> => { throw new Error("plugin reverse RPC is not configured"); };

interface ActiveOperation {
  operationTokenHash: Buffer;
  connectionId: string;
  installationId: string;
  projectId: string;
  pluginId: string;
  pluginVersion: string;
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
}

interface PluginCircuit {
  failures: number;
  openedAt: number;
  probeInProgress: boolean;
}

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
      if (this.options.eventStore.purge) {
        const interval = this.options.maintenanceIntervalMs ?? 3_600_000;
        this.maintenanceTimer = setInterval(() => this.maintain(), interval);
        this.maintenanceTimer.unref?.();
      }
    }
  }

  private maintain(): void {
    if (this.stopping || this.maintenanceRunning || !this.options.eventStore?.purge) return;
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
    try {
      for (let batch = 0; batch < maxBatches && !this.stopping; batch += 1) {
        const result = await this.options.eventStore!.purge!(
          this.options.eventRetentionDays ?? 30,
          this.options.historyRetentionDays ?? 30,
          batchSize,
        );
        events += result.events;
        history += result.history;
        if (result.events < batchSize && result.history < batchSize) break;
      }
      this.log("plugin retention sweep completed", { events, history });
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

  async setInstallationState(installationId: string, state: "enabled" | "disabled"): Promise<void> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
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
    deviceId: string;
    actionId: string;
    actionInput: unknown;
    timeoutMs?: number;
  }): Promise<{ batchId: string; deviceCount: number }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
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
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      deviceId: input.deviceId,
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
      const args: CommandArgument[] = [];
      for (const argument of encoded.args) {
        if (!argument || typeof argument !== "object" || typeof argument.name !== "string" || !argument.name || !Object.prototype.hasOwnProperty.call(argument, "value")) {
          throw publicError("plugin encoder output invalid: each argument must contain a name and value", 502, "invalid_action_output");
        }
        const value = argument.value instanceof Blob ? new Uint8Array(await argument.value.arrayBuffer()) : argument.value;
        args.push({ [argument.name]: value as CommandArgument[string] });
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
        await tx.$queryRaw`SELECT id FROM devices WHERE id = ${input.deviceId}::uuid FOR UPDATE`;
        const binding = await tx.pluginDeviceBinding.findUnique({ where: { deviceId: input.deviceId }, select: { installationId: true } });
        if (!binding || binding.installationId !== installation.id) throw new Error("device is not bound to the plugin installation");
        return enqueueBatchInTransaction(tx, [input.deviceId], { cmd: encoded.command, args });
      });
      return { batchId: batch.id, deviceCount: batch.deviceCount };
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

  private async callUi(session: PluginUiSession, method: "ui.render" | "ui.handleAction", input: { requestId: string; params: Record<string, string | number | boolean>; action?: unknown }): Promise<unknown> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    try {
      assertRpcValueBudget(input, this.valueBudget);
    } catch (error) {
      throw publicError(`plugin UI input is too large: ${(error as Error).message}`, 400, "plugin_ui_invalid_input");
    }
    const installation = await this.options.prisma.pluginInstallation.findUnique({ where: { id: session.installationId }, select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true } });
    if (!installation || installation.state !== "enabled" || installation.projectId !== session.projectId || installation.pluginId !== session.pluginId || installation.pluginVersion !== session.pluginVersion || installation.manifestHash.trim() !== session.manifestHash) throw new Error("plugin UI session is no longer valid");
    const manifest = this.getManifest(session.pluginId, session.pluginVersion);
    if (!manifest?.ui?.routes.some((route) => route.id === session.routeId)) throw new Error("plugin UI route is not declared");
    const { connection } = this.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.registerOperation(operationId, {
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: session.installationId,
      projectId: session.projectId,
      pluginId: session.pluginId,
      pluginVersion: session.pluginVersion,
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
      await this.sealOperation(operationId);
      return result;
    } finally {
      this.finishOperation(operationId);
    }
  }

  private connectionFor(pluginId: string): PluginConnection {
    let connection = this.connections.get(pluginId);
    if (connection) return connection;
    const handlers: ReverseHandlers = {
      entityGet: this.options.reverseHandlers?.entityGet ?? ((input, signal, connectionId) => this.reverseEntityGet(input, signal, connectionId)),
      commandEnqueue: this.options.reverseHandlers?.commandEnqueue ?? ((input, signal, connectionId) => this.reverseCommandEnqueue(input, signal, connectionId)),
      pluginCall: this.options.reverseHandlers?.pluginCall ?? unavailable,
      uiGetData: this.options.reverseHandlers?.uiGetData ?? unavailable,
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
        operationTokenHash: hashOperationToken(operationToken),
        connectionId: connection.id,
        installationId: event.installation_id,
        projectId: event.project_id,
        pluginId: event.plugin_id,
        pluginVersion: event.plugin_version,
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
      }, this.options.eventTimeoutMs ?? 30_000);
      try {
        assertRpcValueBudget(result, this.valueBudget);
      } catch (error) {
        throw Object.assign(new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`), { code: "INVALID_PLUGIN_OUTPUT" });
      }
      await this.sealOperation(operationId);
      const output = result as {
        updates?: readonly (Omit<EntityUpdateInput, "value"> & { value?: EntityUpdateInput["value"] | Blob })[];
        logs?: readonly { level: string; message: string }[];
      };
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
        await store.completeWithUpdates(event.id, event.lease_token, {
          installationId: event.installation_id,
          deviceId: event.device_id,
          profileId: event.profile_id,
          profileVersion: event.profile_version,
          updates,
          commands: operation?.stagedCommands,
        });
      } else {
        const operation = activeOperationId ? this.operations.get(activeOperationId) : undefined;
        if (operation?.stagedCommands?.length) throw new Error("event command intents require transactional completion");
        await store.complete(event.id, event.lease_token);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT" || code === "MANAGER_DATA_CORRUPTION" || /INVALID_(EVENT_INPUT|PLUGIN_OUTPUT)/.test(message);
      const managerDeferral = code === "MANAGER_OVERLOADED" || code === "MANAGER_STATE_UNAVAILABLE";
      const consumeAttempt = permanent || (!pluginCallCompleted && !managerDeferral);
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

  private async reverseEntityGet(input: EntityGetInput, signal: AbortSignal, connectionId: string) {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (!operation.deviceId) throw new Error("entity read requires a device scope");
      if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
      const state = await getPluginEntityState(this.options.prisma, operation.installationId, operation.deviceId, input.entityKey);
      if (!state) return null;
      const value = state.value instanceof Uint8Array ? new Blob([state.value]) : state.value;
      return { ...state, value };
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
      if (!operation.deviceId) throw new Error("command enqueue requires a device scope");
      if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
      assertRpcValueBudget(input.args, this.valueBudget);
      reservation = commandIntentBytes(input.command, input.args);
      if (operation.stagedCommandCount >= (this.options.maxStagedCommands ?? 32)) {
        throw new Error("operation command intent limit exceeded");
      }
      if (operation.stagedCommandBytes + reservation > (this.options.maxStagedCommandBytes ?? 256 * 1024)) {
        throw new Error("operation command intent byte limit exceeded");
      }
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
      const args: CommandArgument[] = [];
      for (const argument of input.args) {
        const value = argument.value instanceof Blob
          ? new Uint8Array(await argument.value.arrayBuffer())
          : argument.value;
        args.push({ [argument.name]: value as CommandArgument[string] });
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
    if (!circuit || circuit.failures < 5) return true;
    if (Date.now() - circuit.openedAt < 30_000) return false;
    if (circuit.probeInProgress) return false;
    circuit.probeInProgress = true;
    return true;
  }

  private circuitFailure(key: string): void {
    const circuit = this.circuits.get(key) ?? { failures: 0, openedAt: 0, probeInProgress: false };
    circuit.failures += 1;
    circuit.probeInProgress = false;
    if (circuit.failures >= 5) circuit.openedAt = Date.now();
    this.circuits.set(key, circuit);
  }

  private circuitSuccess(key: string): void {
    this.circuits.delete(key);
  }

  private circuitReleaseProbe(key: string): void {
    const circuit = this.circuits.get(key);
    if (circuit) circuit.probeInProgress = false;
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

function hashOperationToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function decrementCounter(counters: Map<string, number>, key: string): void {
  const next = (counters.get(key) ?? 1) - 1;
  if (next === 0) counters.delete(key);
  else counters.set(key, next);
}
