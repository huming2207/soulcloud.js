/**
 * Dispatcher-side supervisor for containerised Plugin Hosts.
 *
 * Hosts are independent HTTP services. Docker/Kubernetes owns process
 * lifecycle, memory limits and restart policy; the dispatcher only caches
 * clients and applies a per-plugin failure circuit.
 */

import { PluginHostClient, PluginHostUnavailableError, type PluginHostClientLike } from "./rpc-client";
import type { DispatcherCoreOptions } from "./config";

export interface SupervisorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

interface HostState {
  pluginId: string;
  pluginVersion: string;
  baseUrl: string;
  client: PluginHostClientLike | null;
  starting: Promise<PluginHostClientLike> | null;
  failureTimes: number[];
  benchedUntil: number;
}

export class HostSupervisor {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly options: DispatcherCoreOptions,
    private readonly logger: SupervisorLogger,
  ) {}

  isBenched(pluginId: string): boolean {
    const host = this.hosts.get(pluginId);
    return host !== undefined && host.benchedUntil > Date.now();
  }

  benchedPluginIds(): string[] {
    return [...this.hosts.values()]
      .filter((host) => host.benchedUntil > Date.now())
      .map((host) => host.pluginId);
  }

  async ensureClient(
    pluginId: string,
    pluginVersion: string,
    apiVersion: number,
  ): Promise<PluginHostClientLike> {
    const baseUrl = this.options.hostUrls.get(pluginId);
    if (!baseUrl) {
      throw new PluginHostUnavailableError(
        `no container URL configured for plugin ${pluginId}`,
      );
    }
    let host = this.hosts.get(pluginId);
    if (!host) {
      host = {
        pluginId,
        pluginVersion,
        baseUrl,
        client: null,
        starting: null,
        failureTimes: [],
        benchedUntil: 0,
      };
      this.hosts.set(pluginId, host);
    }
    if (host.pluginVersion !== pluginVersion || host.baseUrl !== baseUrl) {
      host.client?.close();
      host.client = null;
      host.pluginVersion = pluginVersion;
      host.baseUrl = baseUrl;
    }
    if (host.benchedUntil > Date.now()) {
      throw new PluginHostUnavailableError(
        `plugin ${pluginId} is benched after repeated host failures until ${new Date(host.benchedUntil).toISOString()}`,
      );
    }
    if (host.client?.isOpen) return host.client;
    if (host.starting) return host.starting;
    host.starting = this.connectAndHandshake(host, apiVersion);
    try {
      return await host.starting;
    } finally {
      host.starting = null;
    }
  }

  private async connectAndHandshake(
    host: HostState,
    apiVersion: number,
  ): Promise<PluginHostClientLike> {
    let client: PluginHostClientLike;
    try {
      client = await PluginHostClient.connect({
        baseUrl: host.baseUrl,
        maxFrameBytes: this.options.maxFrameBytes,
        authToken: this.options.hostAuthToken,
        reverseHandlers: this.options.reverseHandlers,
        backpressureBytes: this.options.rpcBackpressureBytes,
        maxPendingRequests: this.options.rpcMaxPendingRequests,
        heartbeatIntervalMs: this.options.rpcHeartbeatIntervalMs,
        heartbeatTimeoutMs: this.options.rpcHeartbeatTimeoutMs,
      });
      await client.handshake({
        pluginId: host.pluginId,
        pluginVersion: host.pluginVersion,
        apiVersion,
      });
    } catch (error) {
      this.recordFailure(host, (error as Error).message);
      throw error instanceof PluginHostUnavailableError
        ? error
        : new PluginHostUnavailableError((error as Error).message);
    }
    host.client = client;
    this.logger.info("plugin host ready", {
      pluginId: host.pluginId,
      pluginVersion: host.pluginVersion,
      baseUrl: host.baseUrl,
    });
    return client;
  }

  private recordFailure(host: HostState, reason: string): void {
    const now = Date.now();
    host.failureTimes.push(now);
    host.failureTimes = host.failureTimes.filter(
      (time) => now - time <= this.options.crashWindowMs,
    );
    this.logger.warn("plugin host request failed", {
      pluginId: host.pluginId,
      baseUrl: host.baseUrl,
      reason,
    });
    if (host.failureTimes.length >= this.options.crashThreshold) {
      host.benchedUntil = now + this.options.crashCooldownMs;
      host.failureTimes = [];
      this.logger.error("plugin host benched after repeated failures", {
        pluginId: host.pluginId,
        cooldownMs: this.options.crashCooldownMs,
      });
    }
  }

  /** Invalidate only the local client; remote process lifecycle is external. */
  killHost(pluginId: string): void {
    const host = this.hosts.get(pluginId);
    if (!host) return;
    host.client?.close();
    host.client = null;
    this.recordFailure(host, "request deadline exceeded; HTTP client invalidated");
  }

  async stopAll(): Promise<void> {
    for (const host of this.hosts.values()) {
      host.client?.close();
      host.client = null;
    }
    this.hosts.clear();
  }
}
