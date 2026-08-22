import { validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import { canonicalJson, sha256Hex, type HandshakeOutput } from "@soulcloud/plugin-rpc-contract";
import {
  completePluginEvent,
  decodeDeviceEvent,
  leasePluginEvents,
  releasePluginEvent,
  Prisma,
  type LeasedPluginEvent,
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
  manifestStore?: ManifestStore;
  reverseHandlers?: Partial<ReverseHandlers>;
  eventStore?: PluginEventStore;
  eventPollIntervalMs?: number;
  eventLeaseMs?: number;
  eventBatchSize?: number;
  eventTimeoutMs?: number;
  eventMaxAttempts?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginEventStore {
  lease(limit: number, leaseMs: number): Promise<LeasedPluginEvent[]>;
  complete(eventId: string, leaseToken: string): Promise<boolean>;
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number): Promise<boolean>;
}

export class PrismaPluginEventStore implements PluginEventStore {
  constructor(private readonly prisma: PrismaClient) {}
  lease(limit: number, leaseMs: number) { return leasePluginEvents(this.prisma, limit, leaseMs); }
  complete(eventId: string, leaseToken: string) { return completePluginEvent(this.prisma, eventId, leaseToken); }
  release(eventId: string, leaseToken: string, permanent: boolean, error: string, retryMs: number) {
    return releasePluginEvent(this.prisma, eventId, leaseToken, permanent, error, retryMs);
  }
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

export class PluginManager {
  private readonly connections = new Map<string, PluginConnection>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private eventPollRunning = false;
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
    }
  }

  private connectionFor(pluginId: string): PluginConnection {
    let connection = this.connections.get(pluginId);
    if (connection) return connection;
    const handlers: ReverseHandlers = {
      entityGet: this.options.reverseHandlers?.entityGet ?? unavailable,
      commandEnqueue: this.options.reverseHandlers?.commandEnqueue ?? unavailable,
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
    const connection = this.connections.get(event.plugin_id);
    if (!connection?.isOpen) {
      await this.releaseEvent(event, false, "plugin is unavailable");
      return;
    }
    try {
      const envelope = decodeDeviceEvent(event.payload);
      const result = await connection.request("plugin.handleEvent", {
        operationId: crypto.randomUUID(),
        operationToken: `${crypto.randomUUID()}${crypto.randomUUID()}`,
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
      void result;
      await store.complete(event.id, event.lease_token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT";
      await this.releaseEvent(event, permanent, message);
    }
  }

  private async releaseEvent(event: LeasedPluginEvent, permanent: boolean, message: string): Promise<void> {
    const attempts = event.attempt_count;
    const maxAttempts = this.options.eventMaxAttempts ?? 5;
    const dead = permanent || attempts >= maxAttempts;
    const retryMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
    try {
      await this.options.eventStore!.release(event.id, event.lease_token, dead, message.slice(0, 2_000), retryMs);
    } catch (error) {
      this.log("event lease release failed", { eventId: event.id, error: (error as Error).message });
    }
  }

  listCatalog(): CatalogEntry[] { return [...this.catalog.values()].map((entry) => ({ ...entry, connected: this.connections.get(entry.pluginId)?.isOpen ?? false })); }
  getConnection(pluginId: string): PluginConnection | undefined { return this.connections.get(pluginId); }
  getManifest(pluginId: string, version: string): PluginManifest | undefined { return this.catalog.get(`${pluginId}@${version}`)?.manifest; }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
