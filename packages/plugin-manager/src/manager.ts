import { validateActionInput, validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import { canonicalJson, sha256Hex, type EntityGetInput, type CommandEnqueueInput, type HandshakeOutput } from "@soulcloud/plugin-rpc-contract";
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
  maxReverseCallsPerOperation?: number;
  backpressureBytes: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
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
  eventTimeoutMs?: number;
  eventMaxAttempts?: number;
  eventRetentionDays?: number;
  historyRetentionDays?: number;
  maintenanceIntervalMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginEventStore {
  lease(limit: number, leaseMs: number): Promise<LeasedPluginEvent[]>;
  complete(eventId: string, leaseToken: string): Promise<boolean>;
  completeWithUpdates?(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[]; commands?: readonly { deviceId: string; command: DeviceCommand }[] }): Promise<boolean>;
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number): Promise<boolean>;
  purge?(eventRetentionDays: number, historyRetentionDays: number): Promise<{ events: number; history: number }>;
}

export class PrismaPluginEventStore implements PluginEventStore {
  constructor(private readonly prisma: PrismaClient) {}
  lease(limit: number, leaseMs: number) { return leasePluginEvents(this.prisma, limit, leaseMs); }
  complete(eventId: string, leaseToken: string) { return completePluginEvent(this.prisma, eventId, leaseToken); }
  completeWithUpdates(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[]; commands?: readonly { deviceId: string; command: DeviceCommand }[] }) {
    return completePluginEventWithUpdates(this.prisma, eventId, leaseToken, context);
  }
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number) {
    return releasePluginEvent(this.prisma, eventId, leaseToken, permanent, error, retryMs);
  }
  purge(eventRetentionDays: number, historyRetentionDays: number) { return purgePluginData(this.prisma, eventRetentionDays, historyRetentionDays); }
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
  private readonly circuits = new Map<string, PluginCircuit>();
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private eventPollRunning: Promise<void> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly options: PluginManagerOptions) {
    this.log = options.log ?? ((message, fields) => console.log(`[soulcloud-plugin-manager] ${message}`, fields ?? ""));
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
        this.maintenanceTimer = setInterval(() => void this.runMaintenance(), interval);
        this.maintenanceTimer.unref?.();
      }
    }
  }

  private async runMaintenance(): Promise<void> {
    if (this.stopping || !this.options.eventStore?.purge) return;
    try {
      const result = await this.options.eventStore.purge(this.options.eventRetentionDays ?? 30, this.options.historyRetentionDays ?? 30);
      this.log("plugin retention sweep completed", result);
    } catch (error) {
      this.log("plugin retention sweep failed", { error: (error as Error).message });
    }
  }

  async createInstallation(input: CreateInstallationInput): Promise<{ id: string }> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
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
    if (!action) throw new Error("action is not declared by the plugin manifest");
    const validInput = validateActionInput(action.inputSchema, input.actionInput);
    if (!validInput.ok) throw new Error(`invalid action input: ${validInput.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; ")}`);
    const { connection } = this.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.operations.set(operationId, {
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
        await this.sealOperation(operationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/INVALID_PLUGIN_OUTPUT|plugin encoder/i.test(message)) throw new Error(`plugin encoder output invalid: ${message}`);
        throw error;
      }
      if (!encoded || encoded.command !== action.wire.command || encoded.schemaVersion !== action.wire.schemaVersion || !Array.isArray(encoded.args)) {
        throw new Error("plugin encoder output invalid: command, schemaVersion or args are malformed");
      }
      const args: CommandArgument[] = [];
      for (const argument of encoded.args) {
        if (!argument || typeof argument !== "object" || typeof argument.name !== "string" || !argument.name || !Object.prototype.hasOwnProperty.call(argument, "value")) {
          throw new Error("plugin encoder output invalid: each argument must contain a name and value");
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
      this.operations.delete(operationId);
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
    const installation = await this.options.prisma.pluginInstallation.findUnique({ where: { id: session.installationId }, select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true } });
    if (!installation || installation.state !== "enabled" || installation.projectId !== session.projectId || installation.pluginId !== session.pluginId || installation.pluginVersion !== session.pluginVersion || installation.manifestHash.trim() !== session.manifestHash) throw new Error("plugin UI session is no longer valid");
    const manifest = this.getManifest(session.pluginId, session.pluginVersion);
    if (!manifest?.ui?.routes.some((route) => route.id === session.routeId)) throw new Error("plugin UI route is not declared");
    const { connection } = this.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.operations.set(operationId, {
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
      reverseSettledWaiters: new Set(),
    });
    try {
      const result = await connection.request(method, {
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
      await this.sealOperation(operationId);
      return result;
    } finally {
      this.operations.delete(operationId);
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
      reverseHandlers: handlers,
      onDisconnect: (connectionId) => {
        for (const [operationId, operation] of this.operations) {
          if (operation.connectionId === connectionId) this.operations.delete(operationId);
        }
        this.scheduleReconnect(pluginId);
      },
    };
    connection = new PluginConnection(config);
    this.connections.set(pluginId, connection);
    return connection;
  }

  private async connect(pluginId: string): Promise<void> {
    if (this.stopping) return;
    const connection = this.connectionFor(pluginId);
    try {
      const handshake = await connection.connect();
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
    const timer = setTimeout(() => { this.timers.delete(pluginId); void this.connect(pluginId); }, this.options.reconnectMs);
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
      const events = await this.options.eventStore.lease(
        this.options.eventBatchSize ?? 32,
        this.options.eventLeaseMs ?? 60_000,
      );
      for (const event of events) {
        if (this.stopping) await this.releaseEvent(event, false, "plugin manager is shutting down");
        else await this.dispatchEvent(event);
      }
    } catch (error) {
      this.log("event poll failed", { error: (error as Error).message });
    }
  }

  private async dispatchEvent(event: LeasedPluginEvent): Promise<void> {
    const store = this.options.eventStore!;
    const circuitKey = `${event.plugin_id}\u0000${event.installation_id}`;
    if (!this.circuitAllows(circuitKey)) {
      await this.releaseEvent(event, false, "plugin circuit is open");
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
      await this.releaseEvent(event, false, "matching plugin version is unavailable");
      return;
    }
    let activeOperationId: string | undefined;
    let pluginCallCompleted = false;
    try {
      const manifestEntry = this.catalog.get(`${event.plugin_id}@${event.plugin_version}`);
      if (!manifestEntry) throw new Error("plugin manifest snapshot is unavailable");
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
      const envelope = decodeDeviceEvent(event.payload);
      const operationId = crypto.randomUUID();
      activeOperationId = operationId;
      const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      this.operations.set(operationId, {
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
        reverseSettledWaiters: new Set(),
      });
      const result = await connection.request("plugin.handleEvent", {
        operationId,
        operationToken,
        event: {
          id: event.event_id.trim(),
          seq: event.seq,
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
      await this.sealOperation(operationId);
      pluginCallCompleted = true;
      const output = result as { updates?: readonly EntityUpdateInput[]; logs?: readonly { level: string; message: string }[] };
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
          updates: output.updates ?? [],
          commands: operation?.stagedCommands,
        });
      } else {
        const operation = activeOperationId ? this.operations.get(activeOperationId) : undefined;
        if (operation?.stagedCommands?.length) throw new Error("event command intents require transactional completion");
        await store.complete(event.id, event.lease_token);
      }
      this.circuitSuccess(circuitKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT" || /INVALID_(EVENT_INPUT|PLUGIN_OUTPUT)/.test(message);
      const attemptsExhausted = !permanent && event.attempt_count >= (this.options.eventMaxAttempts ?? 5);
      if (!permanent && !pluginCallCompleted) this.circuitFailure(circuitKey);
      await this.releaseEvent(event, permanent || attemptsExhausted, attemptsExhausted ? `${message}; retry limit exhausted` : message);
    } finally {
      // Operation capabilities are valid only while the parent RPC is live.
      if (activeOperationId) this.operations.delete(activeOperationId);
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
    operation.reverseCalls += 1;
    operation.inFlightReverseCalls += 1;
    return operation;
  }

  private releaseOperation(operation: ActiveOperation): void {
    operation.inFlightReverseCalls -= 1;
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
      return await getPluginEntityState(this.options.prisma, operation.installationId, operation.deviceId, input.entityKey);
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async reverseCommandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.acquireOperation(input, connectionId);
    try {
      if (!operation.deviceId) throw new Error("command enqueue requires a device scope");
      if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
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
      if ((operation.stagedCommands?.length ?? 0) >= 32) throw new Error("operation command intent limit exceeded");
      operation.stagedCommands ??= [];
      operation.stagedCommands.push({ deviceId: operation.deviceId, command: { cmd: input.command, args } });
      return { accepted: true };
    } finally {
      this.releaseOperation(operation);
    }
  }

  private async releaseEvent(event: LeasedPluginEvent, permanent: boolean, message: string): Promise<void> {
    const retryMs = permanent ? 0 : Math.min(60_000, 1_000 * 2 ** Math.min(event.attempt_count, 6));
    try {
      await this.options.eventStore!.release(event.id, event.lease_token, permanent, message.slice(0, 2_000), retryMs);
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
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

function hashOperationToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
