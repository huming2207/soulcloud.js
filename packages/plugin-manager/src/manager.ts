import { validateActionInput, validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import { canonicalJson, sha256Hex, type EntityGetInput, type CommandEnqueueInput, type HandshakeOutput } from "@soulcloud/plugin-rpc-contract";
import {
  completePluginEvent,
  completePluginEventWithUpdates,
  decodeDeviceEvent,
  enqueueBatch,
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
  type PluginUiSession,
  type BindDeviceInput,
  type CreateInstallationInput,
  type PrismaClient,
} from "@soulcloud/core";
import { PluginConnection, type PluginConnectionOptions, type ReverseHandlers } from "./connection";

export interface PluginManagerOptions {
  endpoints: ReadonlyMap<string, string>;
  authToken?: string;
  maxFrameBytes: number;
  maxPendingRequests: number;
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
  completeWithUpdates?(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[] }): Promise<boolean>;
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number): Promise<boolean>;
  purge?(eventRetentionDays: number, historyRetentionDays: number): Promise<{ events: number; history: number }>;
}

export class PrismaPluginEventStore implements PluginEventStore {
  constructor(private readonly prisma: PrismaClient) {}
  lease(limit: number, leaseMs: number) { return leasePluginEvents(this.prisma, limit, leaseMs); }
  complete(eventId: string, leaseToken: string) { return completePluginEvent(this.prisma, eventId, leaseToken); }
  completeWithUpdates(eventId: string, leaseToken: string, context: { installationId: string; deviceId: string; profileId: string; profileVersion: number; updates: readonly EntityUpdateInput[] }) {
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
  insert(snapshot: { pluginId: string; pluginVersion: string; manifestHash: string; apiVersion: number; manifest: PluginManifest }): Promise<void>;
}

/** PostgreSQL is the durable source of truth; no manifest is compiled here. */
export class PrismaManifestStore implements ManifestStore {
  constructor(private readonly prisma: PrismaClient) {}
  async list() {
    const rows = await this.prisma.pluginManifestSnapshot.findMany({ orderBy: [{ pluginId: "asc" }, { firstSeenAt: "desc" }] });
    return rows.map((row) => ({ pluginId: row.pluginId, pluginVersion: row.pluginVersion, manifestHash: row.manifestHash.trim(), manifest: row.canonicalManifest as unknown as PluginManifest }));
  }
  async get(pluginId: string, pluginVersion: string) {
    const row = await this.prisma.pluginManifestSnapshot.findUnique({ where: { pluginId_pluginVersion: { pluginId, pluginVersion } } });
    return row ? { manifestHash: row.manifestHash.trim(), manifest: row.canonicalManifest as unknown as PluginManifest } : null;
  }
  async insert(snapshot: { pluginId: string; pluginVersion: string; manifestHash: string; apiVersion: number; manifest: PluginManifest }): Promise<void> {
    try {
      await this.prisma.pluginManifestSnapshot.create({ data: { pluginId: snapshot.pluginId, pluginVersion: snapshot.pluginVersion, manifestHash: snapshot.manifestHash, canonicalManifest: snapshot.manifest as unknown as Prisma.InputJsonValue, apiVersion: snapshot.apiVersion } });
    } catch (error) {
      // A concurrent Manager may have inserted the same version. The caller
      // re-reads it and rejects a hash mismatch; never overwrite a snapshot.
      if (!(error instanceof Error) || !error.message.includes("Unique constraint")) throw error;
    }
  }
}

const unavailable = async (): Promise<never> => { throw new Error("plugin reverse RPC is not configured"); };

interface ActiveOperation {
  operationToken: string;
  connectionId: string;
  installationId: string;
  projectId: string;
  pluginId: string;
  pluginVersion: string;
  deviceId?: string;
  profileId?: string;
  profileVersion?: number;
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
  private eventPollRunning = false;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly options: PluginManagerOptions) {
    this.log = options.log ?? ((message, fields) => console.log(`[soulcloud-plugin-manager] ${message}`, fields ?? ""));
  }

  async start(): Promise<void> {
    if (this.options.manifestStore) {
      for (const entry of await this.options.manifestStore.list()) this.catalog.set(`${entry.pluginId}@${entry.pluginVersion}`, { ...entry, connected: false });
    }
    for (const [pluginId] of this.options.endpoints) void this.connect(pluginId);
    if (this.options.eventStore) {
      const interval = this.options.eventPollIntervalMs ?? 500;
      this.eventTimer = setInterval(() => void this.consumeEvents(), interval);
      this.eventTimer.unref?.();
      void this.consumeEvents();
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
    const connection = this.connections.get(installation.pluginId);
    if (!connection?.isOpen) throw new Error("plugin is unavailable");
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.operations.set(operationId, {
      operationToken,
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      deviceId: input.deviceId,
    });
    try {
      const encoded = await connection.request("action.encode", {
        operationId,
        operationToken,
        actionId: input.actionId,
        input: input.actionInput,
      }, input.timeoutMs ?? 30_000) as { command: string; args: Array<{ name: string; value: unknown }>; schemaVersion: number };
      if (encoded.command !== action.wire.command || encoded.schemaVersion !== action.wire.schemaVersion) throw new Error("plugin encoder returned a command outside the declared action wire contract");
      const binding = await this.options.prisma.pluginDeviceBinding.findUnique({ where: { deviceId: input.deviceId }, select: { installationId: true } });
      if (!binding || binding.installationId !== installation.id) throw new Error("device is not bound to the plugin installation");
      const args: CommandArgument[] = [];
      for (const argument of encoded.args) {
        const value = argument.value instanceof Blob ? new Uint8Array(await argument.value.arrayBuffer()) : argument.value;
        args.push({ [argument.name]: value as CommandArgument[string] });
      }
      const batch = await enqueueBatch(this.options.prisma, [input.deviceId], { cmd: encoded.command, args });
      return { batchId: batch.id, deviceCount: batch.deviceCount };
    } finally {
      this.operations.delete(operationId);
    }
  }

  async renderPluginUi(session: PluginUiSession, requestId: string, params: Record<string, string>): Promise<unknown> {
    return this.callUi(session, "ui.render", { requestId, params });
  }

  async handlePluginUiAction(session: PluginUiSession, requestId: string, params: Record<string, string>, action: unknown): Promise<unknown> {
    return this.callUi(session, "ui.handleAction", { requestId, params, action });
  }

  private async callUi(session: PluginUiSession, method: "ui.render" | "ui.handleAction", input: { requestId: string; params: Record<string, string>; action?: unknown }): Promise<unknown> {
    if (!this.options.prisma) throw new Error("plugin manager database is not configured");
    const installation = await this.options.prisma.pluginInstallation.findUnique({ where: { id: session.installationId }, select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true } });
    if (!installation || installation.state !== "enabled" || installation.projectId !== session.projectId || installation.pluginId !== session.pluginId || installation.pluginVersion !== session.pluginVersion || installation.manifestHash.trim() !== session.manifestHash) throw new Error("plugin UI session is no longer valid");
    const manifest = this.getManifest(session.pluginId, session.pluginVersion);
    if (!manifest?.ui?.routes.some((route) => route.id === session.routeId)) throw new Error("plugin UI route is not declared");
    const connection = this.connections.get(session.pluginId);
    if (!connection?.isOpen) throw new Error("plugin is unavailable");
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    this.operations.set(operationId, { operationToken, connectionId: connection.id, installationId: session.installationId, projectId: session.projectId, pluginId: session.pluginId, pluginVersion: session.pluginVersion });
    try {
      return await connection.request(method, {
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
      if (!previous && this.options.manifestStore) await this.options.manifestStore.insert({ pluginId: manifest.id, pluginVersion: manifest.version, manifestHash: computed, apiVersion: manifest.apiVersion, manifest });
      this.catalog.set(`${manifest.id}@${manifest.version}`, { pluginId: manifest.id, pluginVersion: manifest.version, manifestHash: computed, manifest, connected: true });
      this.log("plugin connected", { pluginId, version: manifest.version, manifestHash: computed });
    } catch (error) {
      this.log("plugin unavailable", { pluginId, error: (error as Error).message });
      this.scheduleReconnect(pluginId);
    }
  }

  private scheduleReconnect(pluginId: string): void {
    if (this.stopping || this.timers.has(pluginId)) return;
    const timer = setTimeout(() => { this.timers.delete(pluginId); void this.connect(pluginId); }, this.options.reconnectMs);
    timer.unref?.(); this.timers.set(pluginId, timer);
  }

  private async consumeEvents(): Promise<void> {
    if (this.stopping || this.eventPollRunning || !this.options.eventStore) return;
    this.eventPollRunning = true;
    try {
      const events = await this.options.eventStore.lease(
        this.options.eventBatchSize ?? 32,
        this.options.eventLeaseMs ?? 60_000,
      );
      for (const event of events) await this.dispatchEvent(event);
    } catch (error) {
      this.log("event poll failed", { error: (error as Error).message });
    } finally {
      this.eventPollRunning = false;
    }
  }

  private async dispatchEvent(event: LeasedPluginEvent): Promise<void> {
    const store = this.options.eventStore!;
    if (!this.circuitAllows(event.plugin_id)) {
      await this.releaseEvent(event, false, "plugin circuit is open");
      return;
    }
    const connection = this.connections.get(event.plugin_id);
    if (!connection?.isOpen) {
      this.circuitFailure(event.plugin_id);
      await this.releaseEvent(event, false, "plugin is unavailable");
      return;
    }
    let activeOperationId: string | undefined;
    try {
      const envelope = decodeDeviceEvent(event.payload);
      const operationId = crypto.randomUUID();
      activeOperationId = operationId;
      const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      this.operations.set(operationId, {
        operationToken,
        connectionId: connection.id,
        installationId: event.installation_id,
        projectId: event.project_id,
        pluginId: event.plugin_id,
        pluginVersion: event.plugin_version,
        deviceId: event.device_id,
        profileId: event.profile_id,
        profileVersion: event.profile_version,
      });
      const result = await connection.request("plugin.handleEvent", {
        operationId,
        operationToken,
        event: {
          id: event.event_id.trim(),
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
      const output = result as { updates?: readonly EntityUpdateInput[] };
      if (store.completeWithUpdates) {
        await store.completeWithUpdates(event.id, event.lease_token, {
          installationId: event.installation_id,
          deviceId: event.device_id,
          profileId: event.profile_id,
          profileVersion: event.profile_version,
          updates: output.updates ?? [],
        });
      } else {
        await store.complete(event.id, event.lease_token);
      }
      this.circuitSuccess(event.plugin_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT" || /INVALID_(EVENT_INPUT|PLUGIN_OUTPUT)/.test(message);
      if (permanent) this.circuitSuccess(event.plugin_id);
      else this.circuitFailure(event.plugin_id);
      await this.releaseEvent(event, permanent, message);
    } finally {
      // Operation capabilities are valid only while the parent RPC is live.
      if (activeOperationId) this.operations.delete(activeOperationId);
    }
  }

  private operationFor(input: { operationId: string; operationToken: string }, connectionId: string): ActiveOperation {
    const operation = this.operations.get(input.operationId);
    if (!operation || operation.connectionId !== connectionId || operation.operationToken !== input.operationToken) {
      throw new Error("operation capability is invalid or expired");
    }
    return operation;
  }

  private async reverseEntityGet(input: EntityGetInput, signal: AbortSignal, connectionId: string) {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.operationFor(input, connectionId);
    if (!operation.deviceId) throw new Error("entity read requires a device scope");
    if (!this.options.prisma) throw new Error("plugin reverse RPC is not configured");
    return getPluginEntityState(this.options.prisma, operation.installationId, operation.deviceId, input.entityKey);
  }

  private async reverseCommandEnqueue(input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }> {
    if (signal.aborted) throw new Error("operation aborted");
    const operation = this.operationFor(input, connectionId);
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
    await enqueueBatch(this.options.prisma, [operation.deviceId], { cmd: input.command, args });
    return { accepted: true };
  }

  private async releaseEvent(event: LeasedPluginEvent, permanent: boolean, message: string): Promise<void> {
    const retryMs = permanent ? 0 : Math.min(60_000, 1_000 * 2 ** Math.min(event.attempt_count, 6));
    try {
      await this.options.eventStore!.release(event.id, event.lease_token, permanent, message.slice(0, 2_000), retryMs);
    } catch (error) {
      this.log("event lease release failed", { eventId: event.id, error: (error as Error).message });
    }
  }

  private circuitAllows(pluginId: string): boolean {
    const circuit = this.circuits.get(pluginId);
    if (!circuit || circuit.failures < 5) return true;
    if (Date.now() - circuit.openedAt < 30_000) return false;
    if (circuit.probeInProgress) return false;
    circuit.probeInProgress = true;
    return true;
  }

  private circuitFailure(pluginId: string): void {
    const circuit = this.circuits.get(pluginId) ?? { failures: 0, openedAt: 0, probeInProgress: false };
    circuit.failures += 1;
    circuit.probeInProgress = false;
    if (circuit.failures >= 5) circuit.openedAt = Date.now();
    this.circuits.set(pluginId, circuit);
  }

  private circuitSuccess(pluginId: string): void {
    this.circuits.delete(pluginId);
  }

  listCatalog(): CatalogEntry[] { return [...this.catalog.values()].map((entry) => ({ ...entry, connected: this.connections.get(entry.pluginId)?.isOpen ?? false })); }
  getConnection(pluginId: string): PluginConnection | undefined { return this.connections.get(pluginId); }
  getManifest(pluginId: string, version: string): PluginManifest | undefined { return this.catalog.get(`${pluginId}@${version}`)?.manifest; }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
