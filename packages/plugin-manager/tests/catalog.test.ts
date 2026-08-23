import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import type { PluginUiSession } from "@soulcloud/core";
import type { PluginConnection } from "../src/connection";
import { PluginManager, type ManifestStore } from "../src/manager";
import { canonicalJson, sha256Hex } from "@soulcloud/plugin-rpc-contract";

function manifest(version: string): PluginManifest {
  return { id: "example.plugin", version, apiVersion: 1, profiles: [], actions: [], events: [] };
}

describe("plugin catalog connection state", () => {
  test("marks only the exact connected version and hash as available", async () => {
    const first = manifest("1.0.0");
    const second = manifest("2.0.0");
    const firstHash = await sha256Hex(canonicalJson(first));
    const secondHash = await sha256Hex(canonicalJson(second));
    const store: ManifestStore = {
      list: async () => [
        { pluginId: first.id, pluginVersion: first.version, manifestHash: firstHash, manifest: first },
        { pluginId: second.id, pluginVersion: second.version, manifestHash: secondHash, manifest: second },
      ],
      get: async () => null,
      insert: async () => { throw new Error("not used"); },
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000, manifestStore: store,
    });
    await manager.start();
    const internals = manager as unknown as { connections: Map<string, PluginConnection> };
    internals.connections.set(first.id, {
      isOpen: true,
      manifest: { pluginVersion: second.version, manifestHash: secondHash },
    } as unknown as PluginConnection);

    expect(manager.listCatalog().map((entry) => [entry.pluginVersion, entry.connected]))
      .toEqual([["1.0.0", false], ["2.0.0", true]]);
  });

  test("releases hierarchical operation capacity", () => {
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, maxOperations: 1, maxOperationsPerPlugin: 1,
      maxOperationsPerInstallation: 1, backpressureBytes: 1024,
      heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 1000, reconnectMs: 1000,
    });
    const internals = manager as unknown as {
      registerOperation(id: string, operation: object): void;
      finishOperation(id: string): void;
    };
    const operation = {
      kind: "event",
      operationTokenHash: Buffer.alloc(32),
      connectionId: "connection",
      installationId: "installation",
      projectId: "project",
      pluginId: "example.plugin",
      pluginVersion: "1.0.0",
      deadline: performance.now() + 1_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set<() => void>(),
    };
    internals.registerOperation("first", operation);
    expect(() => internals.registerOperation("second", { ...operation })).toThrow("operation limit");
    internals.finishOperation("first");
    expect(() => internals.registerOperation("second", { ...operation })).not.toThrow();
  });

  test("does not enable an installation whose pinned plugin is offline", async () => {
    const persisted = manifest("1.0.0");
    const manifestHash = await sha256Hex(canonicalJson(persisted));
    const prisma = {
      pluginInstallation: {
        findUnique: async () => ({
          pluginId: persisted.id,
          pluginVersion: persisted.version,
          manifestHash,
        }),
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000, prisma: prisma as never,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
    };
    internals.catalog.set(`${persisted.id}@${persisted.version}`, {
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash,
      manifest: persisted,
      connected: false,
    });

    await expect(manager.setInstallationState("installation", "enabled")).rejects.toThrow("unavailable");
  });

  test("enforces reverse command operation scope and staged bytes before database work", async () => {
    let databaseReads = 0;
    const prisma = {
      pluginDeviceBinding: {
        findUnique: async () => {
          databaseReads += 1;
          return null;
        },
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000, prisma: prisma as never,
      maxStagedCommandBytes: 4,
    });
    const operationToken = "0".repeat(64);
    const operation = {
      kind: "action",
      operationTokenHash: createHash("sha256").update(operationToken).digest(),
      connectionId: "connection",
      installationId: "installation",
      projectId: "project",
      pluginId: "example.plugin",
      pluginVersion: "1.0.0",
      deviceId: "device",
      deadline: performance.now() + 1_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set<() => void>(),
    };
    const internals = manager as unknown as {
      operations: Map<string, typeof operation>;
      reverseCommandEnqueue(input: object, signal: AbortSignal, connectionId: string): Promise<unknown>;
    };
    internals.operations.set("operation", operation);

    await expect(internals.reverseCommandEnqueue({
      operationId: "operation",
      operationToken,
      deadlineMs: 1_000,
      command: "x",
      args: [],
    }, new AbortController().signal, "connection")).rejects.toThrow("not allowed");
    operation.kind = "event";
    await expect(internals.reverseCommandEnqueue({
      operationId: "operation",
      operationToken,
      deadlineMs: 1_000,
      command: "command",
      args: [{ name: "payload", value: new Blob([Uint8Array.of(1)]) }],
    }, new AbortController().signal, "connection")).rejects.toThrow("byte limit");
    expect(databaseReads).toBe(0);
    expect(operation.stagedCommandCount).toBe(0);
    expect(operation.stagedCommandBytes).toBe(0);
  });

  test("does not return SSR output after the installation is disabled in flight", async () => {
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      ui: { routes: [{ id: "main", path: "/main" }] },
    };
    const manifestHash = await sha256Hex(canonicalJson(persisted));
    let reads = 0;
    const prisma = {
      pluginInstallation: {
        findUnique: async () => {
          reads += 1;
          return {
            projectId: "00000000-0000-4000-8000-000000000001",
            pluginId: persisted.id,
            pluginVersion: persisted.version,
            manifestHash,
            state: reads === 1 ? "enabled" : "disabled",
          };
        },
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000, prisma: prisma as never,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      connections: Map<string, PluginConnection>;
    };
    internals.catalog.set(`${persisted.id}@${persisted.version}`, {
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash,
      manifest: persisted,
      connected: true,
    });
    internals.connections.set(persisted.id, {
      id: "connection",
      isOpen: true,
      manifest: { pluginVersion: persisted.version, manifestHash },
      request: async () => ({ html: "<p>stale</p>" }),
    } as unknown as PluginConnection);
    const session: PluginUiSession = {
      sub: "00000000-0000-4000-8000-000000000002",
      projectId: "00000000-0000-4000-8000-000000000001",
      installationId: "00000000-0000-4000-8000-000000000003",
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash,
      routeId: "main",
      permissions: [],
      locale: "en",
      nonce: "nonce",
    };

    await expect(manager.renderPluginUi(session, "request", {})).rejects.toThrow("no longer valid");
    expect(reads).toBe(2);
  });
});
