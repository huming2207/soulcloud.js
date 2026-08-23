import { describe, expect, test } from "bun:test";
import { encodeDeviceEvent, type LeasedPluginEvent } from "@soulcloud/core";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import type { PluginConnection } from "../src/connection";
import { PluginManager, type PluginEventStore } from "../src/manager";

function leasedEvent(id: string, installationId = "installation-id"): LeasedPluginEvent {
  return {
    id,
    event_id: id,
    device_id: "device-id",
    device_uid: "device-uid",
    project_id: "project-id",
    seq: "1",
    kind: "fixture.result",
    schema: 1,
    payload: Buffer.alloc(0),
    received_at: new Date(0),
    installation_id: installationId,
    plugin_id: "example.plugin",
    plugin_version: "1.0.0",
    manifest_hash: "hash",
    profile_id: "fixture",
    profile_version: 1,
    installation_config: {},
    attempt_count: 1,
    lease_token: `lease-${id}`,
  };
}

describe("plugin event consumer", () => {
  test("consumes a retry attempt without tripping the plugin circuit when database commit fails", async () => {
    const event = leasedEvent("commit-failure");
    event.payload = Buffer.from(encodeDeviceEvent({
      id: Uint8Array.from({ length: 16 }, (_, index) => index),
      seq: 1n,
      kind: event.kind,
      schema: event.schema,
      data: { value: 1 },
    }));
    let consumedAttempt: boolean | undefined;
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      completeWithUpdates: async () => { throw new Error("database commit failed"); },
      release: async (_id, _token, _permanent, _error, _retryMs, consumeAttempt) => {
        consumedAttempt = consumeAttempt;
        return true;
      },
    };
    const profile = {
      id: event.profile_id,
      version: event.profile_version,
      manufacturer: "Soulcloud",
      model: "fixture",
      capabilities: [],
      entities: [],
    };
    const manifest: PluginManifest = {
      id: event.plugin_id,
      version: event.plugin_version,
      apiVersion: 1,
      profiles: [profile],
      actions: [],
      events: [{ kind: event.kind, schemaVersion: event.schema }],
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      connections: Map<string, PluginConnection>;
      circuits: Map<string, unknown>;
      dispatchEvent(value: LeasedPluginEvent): Promise<void>;
    };
    internals.catalog.set(`${event.plugin_id}@${event.plugin_version}`, {
      pluginId: event.plugin_id,
      pluginVersion: event.plugin_version,
      manifestHash: event.manifest_hash,
      manifest,
      connected: true,
    });
    internals.connections.set(event.plugin_id, {
      id: "connection",
      isOpen: true,
      manifest: { pluginVersion: event.plugin_version, manifestHash: event.manifest_hash },
      request: async () => ({ updates: [], logs: [] }),
    } as unknown as PluginConnection);

    await internals.dispatchEvent(event);

    expect(consumedAttempt).toBe(true);
    expect(internals.circuits.has(`${event.plugin_id}\u0000${event.installation_id}`)).toBe(false);
  });

  test("renews the current and pending events while draining a leased batch", async () => {
    const events = [leasedEvent("first"), leasedEvent("second")];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let renewed!: (leases: readonly { id: string; leaseToken: string }[]) => void;
    const renewalObserved = new Promise<readonly { id: string; leaseToken: string }[]>((resolve) => {
      renewed = resolve;
    });
    const store: PluginEventStore = {
      lease: async () => events,
      complete: async () => true,
      release: async () => true,
      renew: async (leases) => {
        renewed(leases);
        return leases.length;
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
      eventLeaseMs: 30,
    });
    const internals = manager as unknown as {
      consumeEventBatch(): Promise<void>;
      dispatchEvent(event: LeasedPluginEvent): Promise<void>;
    };
    const dispatched: string[] = [];
    internals.dispatchEvent = async (event) => {
      dispatched.push(event.id);
      if (event.id === "first") await firstBlocked;
    };

    const consuming = internals.consumeEventBatch();
    expect(await renewalObserved).toEqual([
      { id: "first", leaseToken: "lease-first" },
      { id: "second", leaseToken: "lease-second" },
    ]);
    releaseFirst();
    await consuming;
    expect(dispatched).toEqual(["first", "second"]);
  });

  test("isolates installations without reordering events within one installation", async () => {
    const events = [
      leasedEvent("first-a", "installation-a"),
      leasedEvent("first-b", "installation-b"),
      leasedEvent("second-a", "installation-a"),
    ];
    let releaseA!: () => void;
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    let bDispatched!: () => void;
    const observedB = new Promise<void>((resolve) => { bDispatched = resolve; });
    const store: PluginEventStore = {
      lease: async () => events,
      complete: async () => true,
      release: async () => true,
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
      eventMaxConcurrency: 2,
    });
    const internals = manager as unknown as {
      consumeEventBatch(): Promise<void>;
      dispatchEvent(event: LeasedPluginEvent): Promise<void>;
    };
    const dispatched: string[] = [];
    internals.dispatchEvent = async (event) => {
      dispatched.push(event.id);
      if (event.id === "first-a") await aBlocked;
      if (event.id === "first-b") bDispatched();
    };

    const consuming = internals.consumeEventBatch();
    await observedB;
    expect(dispatched).toEqual(["first-a", "first-b"]);
    releaseA();
    await consuming;
    expect(dispatched).toEqual(["first-a", "first-b", "second-a"]);
  });

  test("does not consume an attempt while the matching plugin version is unavailable", async () => {
    let consumedAttempt: boolean | undefined;
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      release: async (_id, _token, _permanent, _error, _retryMs, consumeAttempt) => {
        consumedAttempt = consumeAttempt;
        return true;
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
    });
    const internals = manager as unknown as { dispatchEvent(event: LeasedPluginEvent): Promise<void> };
    await internals.dispatchEvent(leasedEvent("offline"));
    expect(consumedAttempt).toBe(false);
  });

  test("releases a half-open probe after a Manager-state deferral", async () => {
    const errors: string[] = [];
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      release: async (_id, _token, _permanent, error) => {
        errors.push(error);
        return true;
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
    });
    const event = leasedEvent("half-open");
    const circuitKey = `${event.plugin_id}\u0000${event.installation_id}`;
    const internals = manager as unknown as {
      connections: Map<string, object>;
      circuits: Map<string, { failures: number; openedAt: number; probeInProgress: boolean }>;
      dispatchEvent(event: LeasedPluginEvent): Promise<void>;
    };
    internals.connections.set(event.plugin_id, {
      isOpen: true,
      manifest: { pluginVersion: event.plugin_version, manifestHash: event.manifest_hash },
    });
    internals.circuits.set(circuitKey, {
      failures: 5,
      openedAt: Date.now() - 31_000,
      probeInProgress: false,
    });

    await internals.dispatchEvent(event);
    await internals.dispatchEvent(event);

    expect(errors).toEqual([
      "plugin manifest snapshot is unavailable",
      "plugin manifest snapshot is unavailable",
    ]);
  });
});

describe("plugin data retention", () => {
  test("catches up in bounded batches and does not overlap sweeps", async () => {
    let purgeCalls = 0;
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      release: async () => true,
      purge: async (_eventDays, _historyDays, batchSize) => {
        purgeCalls += 1;
        return purgeCalls === 1 ? { events: batchSize, history: 0 } : { events: 0, history: 0 };
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
      retentionBatchSize: 2,
      retentionMaxBatches: 4,
      log: () => undefined,
    });
    const internals = manager as unknown as {
      maintain(): void;
      maintenanceRunning: Promise<void> | null;
    };

    internals.maintain();
    const running = internals.maintenanceRunning;
    internals.maintain();
    await running;
    expect(purgeCalls).toBe(2);
  });
});
