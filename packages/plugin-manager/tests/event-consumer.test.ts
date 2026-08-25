import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encodeDeviceEvent, type LeasedPluginEvent } from "@soulcloud/core";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import { PluginConnectionOverloaded, type PluginConnection } from "../src/connection";
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

  test("defers local Manager overload without consuming the event attempt or opening the circuit", async () => {
    const event = leasedEvent("manager-overload");
    event.payload = Buffer.from(encodeDeviceEvent({
      id: Uint8Array.from({ length: 16 }, (_, index) => index),
      seq: 1n,
      kind: event.kind,
      schema: event.schema,
      data: { value: 1 },
    }));
    let consumedAttempt: boolean | undefined;
    let permanent: boolean | undefined;
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      completeWithUpdates: async () => true,
      release: async (_id, _token, isPermanent, _error, _retryMs, consume) => {
        permanent = isPermanent;
        consumedAttempt = consume;
        return true;
      },
    };
    const manifest: PluginManifest = {
      id: event.plugin_id,
      version: event.plugin_version,
      apiVersion: 1,
      profiles: [{
        id: event.profile_id,
        version: event.profile_version,
        manufacturer: "Soulcloud",
        model: "fixture",
        capabilities: [],
        entities: [],
      }],
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
      request: async () => { throw new PluginConnectionOverloaded("plugin Manager request limit reached"); },
    } as unknown as PluginConnection);

    await internals.dispatchEvent(event);

    expect(permanent).toBe(false);
    expect(consumedAttempt).toBe(false);
    expect(internals.circuits.has(`${event.plugin_id}\u0000${event.installation_id}`)).toBe(false);
  });

  test("classifies a malformed plugin event output as permanent plugin failure", async () => {
    const event = leasedEvent("malformed-output");
    event.payload = Buffer.from(encodeDeviceEvent({
      id: Uint8Array.from({ length: 16 }, (_, index) => index),
      seq: 1n,
      kind: event.kind,
      schema: event.schema,
      data: { value: 1 },
    }));
    let permanent: boolean | undefined;
    let errorMessage = "";
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      completeWithUpdates: async () => true,
      release: async (_id, _token, isPermanent, error) => {
        permanent = isPermanent;
        errorMessage = error;
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
      request: async () => ({ updates: [], logs: { malformed: true } }),
    } as unknown as PluginConnection);

    await internals.dispatchEvent(event);

    expect(permanent).toBe(true);
    expect(errorMessage).toContain("INVALID_PLUGIN_OUTPUT");
    expect(internals.circuits.has(`${event.plugin_id}\u0000${event.installation_id}`)).toBe(false);
  });

  test("passes the current execution capability to events for the leased device", async () => {
    const event = leasedEvent("execution-event");
    event.payload = Buffer.from(encodeDeviceEvent({
      id: Uint8Array.from({ length: 16 }, (_, index) => index),
      seq: 1n,
      kind: event.kind,
      schema: event.schema,
      data: { value: 1 },
    }));
    const executionId = randomUUID();
    const executionToken = `${randomUUID()}${randomUUID()}`;
    const captured: { execution?: unknown } = {};
    const store: PluginEventStore = {
      lease: async () => [],
      complete: async () => true,
      completeWithUpdates: async () => true,
      release: async () => true,
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
      prisma: { $queryRaw: async () => [{
        id: executionId,
        installation_id: event.installation_id,
        device_id: event.device_id,
        initiating_user_id: randomUUID(),
        plugin_id: event.plugin_id,
        plugin_version: event.plugin_version,
        manifest_hash: event.manifest_hash,
        allowed_capabilities: ["device.enqueue_command"],
        state: "active",
        device_lease_expires_at: new Date(Date.now() + 60_000),
        expires_at: new Date(Date.now() + 300_000),
        created_at: new Date(),
        updated_at: new Date(),
        finished_at: null,
      }] } as never,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      connections: Map<string, PluginConnection>;
      executionTokens: Map<string, { installationId: string; deviceId: string; token: string; expiresAt: number }>;
      executionByDevice: Map<string, string>;
      dispatchEvent(value: LeasedPluginEvent): Promise<void>;
    };
    internals.catalog.set(`${event.plugin_id}@${event.plugin_version}`, {
      pluginId: event.plugin_id,
      pluginVersion: event.plugin_version,
      manifestHash: event.manifest_hash,
      manifest,
      connected: true,
    });
    internals.executionTokens.set(executionId, {
      installationId: event.installation_id,
      deviceId: event.device_id,
      token: executionToken,
      expiresAt: Date.now() + 300_000,
    });
    internals.executionByDevice.set(`${event.installation_id}\u0000${event.device_id}`, executionId);
    internals.connections.set(event.plugin_id, {
      id: "connection",
      isOpen: true,
      manifest: { pluginVersion: event.plugin_version, manifestHash: event.manifest_hash },
      request: async (_method: string, input: { execution?: unknown }) => {
        captured.execution = input.execution;
        return { updates: [], logs: [] };
      },
    } as unknown as PluginConnection);

    await internals.dispatchEvent(event);

    expect(captured.execution).toEqual({ executionId, executionToken });
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

  test("reopens an abandoned half-open probe after its bounded lease expires", () => {
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
    });
    const circuitKey = "plugin\u0000installation";
    const now = Date.now();
    const internals = manager as unknown as {
      circuits: Map<string, { failures: number; openedAt: number; probeInProgress: boolean; probeStartedAt?: number; lastTouchedAt?: number }>;
      circuitAllows(key: string): boolean;
    };
    internals.circuits.set(circuitKey, {
      failures: 5,
      openedAt: now - 60_000,
      probeInProgress: true,
      probeStartedAt: now - 35_001,
      lastTouchedAt: now - 35_001,
    });

    expect(internals.circuitAllows(circuitKey)).toBe(true);
    expect(internals.circuits.get(circuitKey)?.probeInProgress).toBe(true);
    expect(internals.circuits.get(circuitKey)?.probeStartedAt).toBeGreaterThan(now - 1_000);
  });

  test("prunes idle circuit entries without removing an active probe", () => {
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
    });
    const now = 1_000_000;
    const internals = manager as unknown as {
      circuits: Map<string, { failures: number; openedAt: number; probeInProgress: boolean; probeStartedAt?: number; lastTouchedAt?: number }>;
      pruneCircuits(value: number): void;
    };
    internals.circuits.set("idle", { failures: 1, openedAt: 0, probeInProgress: false, lastTouchedAt: now - 600_001 });
    internals.circuits.set("probe", { failures: 5, openedAt: now - 31_000, probeInProgress: true, probeStartedAt: now - 100, lastTouchedAt: now - 100 });
    internals.circuits.set("recent", { failures: 2, openedAt: 0, probeInProgress: false, lastTouchedAt: now - 1 });

    internals.pruneCircuits(now);

    expect(internals.circuits.has("idle")).toBe(false);
    expect(internals.circuits.has("probe")).toBe(true);
    expect(internals.circuits.has("recent")).toBe(true);
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
