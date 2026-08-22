import type { PluginManifest } from "@soulcloud/plugin-sdk";
import { canonicalJson, sha256Hex, type HandshakeOutput } from "@soulcloud/plugin-rpc-contract";
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
  reverseHandlers?: Partial<ReverseHandlers>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CatalogEntry {
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  manifest: PluginManifest;
  connected: boolean;
}

const unavailable = async (): Promise<never> => { throw new Error("plugin reverse RPC is not configured"); };

export class PluginManager {
  private readonly connections = new Map<string, PluginConnection>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly options: PluginManagerOptions) {
    this.log = options.log ?? ((message, fields) => console.log(`[soulcloud-plugin-manager] ${message}`, fields ?? ""));
  }

  start(): void { for (const [pluginId] of this.options.endpoints) void this.connect(pluginId); }

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
      const manifest = handshake.manifest as PluginManifest;
      const computed = await sha256Hex(canonicalJson(manifest));
      if (computed !== handshake.manifestHash) throw new Error(`manifest hash mismatch for ${pluginId}`);
      if (manifest.id !== pluginId || manifest.version !== handshake.pluginVersion) throw new Error(`manifest identity mismatch for ${pluginId}`);
      const previous = this.catalog.get(`${manifest.id}@${manifest.version}`);
      if (previous && previous.manifestHash !== computed) throw new Error(`manifest drift for ${manifest.id}@${manifest.version}`);
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

  listCatalog(): CatalogEntry[] { return [...this.catalog.values()].map((entry) => ({ ...entry, connected: this.connections.get(entry.pluginId)?.isOpen ?? false })); }
  getConnection(pluginId: string): PluginConnection | undefined { return this.connections.get(pluginId); }
  getManifest(pluginId: string, version: string): PluginManifest | undefined { return this.catalog.get(`${pluginId}@${version}`)?.manifest; }

  async stop(): Promise<void> { this.stopping = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for (const connection of this.connections.values()) connection.close(); this.connections.clear(); }
}
