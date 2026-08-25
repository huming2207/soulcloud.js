import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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

  test("checks durable execution scope and capability before allowing reverse access", async () => {
    const operationToken = "operation-token-for-execution";
    const executionToken = "execution-token-for-manager";
    const executionId = "00000000-0000-4000-8000-000000000001";
    const installationId = "00000000-0000-4000-8000-000000000002";
    const deviceId = "00000000-0000-4000-8000-000000000003";
    const row = {
      id: executionId,
      installation_id: installationId,
      device_id: deviceId,
      initiating_user_id: "00000000-0000-4000-8000-000000000004",
      plugin_id: "example.plugin",
      plugin_version: "1.0.0",
      manifest_hash: "a".repeat(64),
      allowed_capabilities: ["execution.get"],
      state: "active",
      device_lease_expires_at: new Date(1_000),
      expires_at: new Date(2_000),
      created_at: new Date(0),
      updated_at: new Date(1_000),
      finished_at: null,
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000,
      prisma: { $queryRaw: async () => [row] } as never,
    });
    const operation = {
      kind: "event" as const,
      operationTokenHash: createHash("sha256").update(operationToken).digest(),
      connectionId: "connection",
      installationId,
      projectId: "00000000-0000-4000-8000-000000000005",
      pluginId: "example.plugin",
      pluginVersion: "1.0.0",
      manifestHash: "a".repeat(64),
      deviceId,
      deadline: performance.now() + 1_000,
      state: "active" as const,
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set<() => void>(),
    };
    const internals = manager as unknown as {
      operations: Map<string, typeof operation>;
      reverseExecutionGet(input: object, signal: AbortSignal, connectionId: string): Promise<unknown>;
    };
    internals.operations.set("operation", operation);
    await expect(internals.reverseExecutionGet({ operationId: "operation", operationToken, deadlineMs: 1_000, executionId, executionToken }, new AbortController().signal, "connection"))
      .resolves.toMatchObject({ id: executionId, state: "active" });
    row.allowed_capabilities = ["execution.release"];
    await expect(internals.reverseExecutionGet({ operationId: "operation", operationToken, deadlineMs: 1_000, executionId, executionToken }, new AbortController().signal, "connection"))
      .rejects.toThrow("execution.get is not granted");
  });

  test("does not let an execution capability bypass manifest human approval", async () => {
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      actions: [{ id: "reset", inputSchema: {}, wire: { command: "debug.reset", schemaVersion: 1 }, requiresHumanApproval: true }],
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000,
      prisma: { $queryRaw: async () => { throw new Error("database must not be reached"); } } as never,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      operations: Map<string, { kind: "event"; operationTokenHash: Buffer; connectionId: string; installationId: string; projectId: string; pluginId: string; pluginVersion: string; deviceId: string; deadline: number; state: "active"; reverseCalls: number; inFlightReverseCalls: number; stagedCommandCount: number; stagedCommandBytes: number; reverseSettledWaiters: Set<() => void> }>;
      reverseDeviceEnqueue(input: object, signal: AbortSignal, connectionId: string): Promise<unknown>;
    };
    internals.catalog.set(`${persisted.id}@${persisted.version}`, { pluginId: persisted.id, pluginVersion: persisted.version, manifestHash: "a".repeat(64), manifest: persisted, connected: true });
    const operationToken = "operation-token-for-device";
    internals.operations.set("operation", {
      kind: "event",
      operationTokenHash: createHash("sha256").update(operationToken).digest(),
      connectionId: "connection",
      installationId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      deviceId: "00000000-0000-4000-8000-000000000003",
      deadline: performance.now() + 1_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    await expect(internals.reverseDeviceEnqueue({ operationId: "operation", operationToken, deadlineMs: 1_000, executionId: "00000000-0000-4000-8000-000000000004", executionToken: `${randomUUID()}${randomUUID()}`, command: "debug.reset", args: [] }, new AbortController().signal, "connection"))
      .rejects.toThrow("requires human approval");
  });

  test("validates execution command arguments against the manifest action schema", () => {
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      actions: [{
        id: "read",
        inputSchema: { length: { type: "integer", required: true, min: 1, max: 32 } },
        wire: { command: "debug.read_memory", schemaVersion: 1 },
      }],
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      assertExecutionCommandAllowed(operation: { kind: "event"; pluginId: string; pluginVersion: string }, command: string, args: Array<Record<string, unknown>>): void;
    };
    internals.catalog.set(`${persisted.id}@${persisted.version}`, {
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash: "a".repeat(64),
      manifest: persisted,
      connected: true,
    });
    const operation = { kind: "event" as const, pluginId: persisted.id, pluginVersion: persisted.version };
    expect(() => internals.assertExecutionCommandAllowed(operation, "debug.read_memory", [{ length: 32 }])).not.toThrow();
    expect(() => internals.assertExecutionCommandAllowed(operation, "debug.read_memory", [{ length: 33 }])).toThrow("action schema");
  });

  test("classifies encoder args that violate the action schema as plugin output", async () => {
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      actions: [{
        id: "read",
        inputSchema: { length: { type: "integer", required: true, min: 1, max: 32 } },
        wire: { command: "debug.read_memory", schemaVersion: 1 },
      }],
    };
    const manifestHash = await sha256Hex(canonicalJson(persisted));
    const installationId = randomUUID();
    const projectId = randomUUID();
    const deviceId = randomUUID();
    const userId = randomUUID();
    const connection = {
      id: "connection",
      isOpen: true,
      manifest: { pluginVersion: persisted.version, manifestHash },
      request: async () => ({ command: "debug.read_memory", schemaVersion: 1, args: [{ name: "length", value: 33 }] }),
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => ({ id: installationId, projectId, pluginId: persisted.id, pluginVersion: persisted.version, manifestHash, state: "enabled" }),
        },
        $transaction: async () => { throw new Error("transaction must not be reached for invalid plugin output"); },
      } as never,
    });
    const internals = manager as unknown as {
      catalog: Map<string, { pluginId: string; pluginVersion: string; manifestHash: string; manifest: PluginManifest; connected: boolean }>;
      connections: Map<string, PluginConnection>;
    };
    internals.catalog.set(`${persisted.id}@${persisted.version}`, { pluginId: persisted.id, pluginVersion: persisted.version, manifestHash, manifest: persisted, connected: true });
    internals.connections.set(persisted.id, connection as unknown as PluginConnection);

    await expect(manager.encodeAction({
      installationId,
      userId,
      deviceId,
      actionId: "read",
      actionInput: { length: 4 },
    })).rejects.toMatchObject({ status: 502, publicCode: "invalid_action_output" });
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

  test("rejects an asset whose MIME differs from the manifest", async () => {
    const bytes = new TextEncoder().encode("console.log('asset');");
    const assetHash = createHash("sha256").update(bytes).digest("hex");
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      ui: {
        routes: [{ id: "main", path: "/main" }],
        assets: [{ path: `/main/app.${assetHash}.js`, contentType: "text/javascript; charset=utf-8", sha256: assetHash }],
      },
    };
    const manifestHash = await sha256Hex(canonicalJson(persisted));
    const installationId = randomUUID();
    const projectId = randomUUID();
    const prisma = {
      pluginInstallation: {
        findUnique: async () => ({
          projectId,
          pluginId: persisted.id,
          pluginVersion: persisted.version,
          manifestHash,
          state: "enabled",
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
      request: async () => ({ body: new Blob([bytes]), contentType: "application/json" }),
    } as unknown as PluginConnection);
    const session: PluginUiSession = {
      sub: randomUUID(),
      projectId,
      installationId,
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash,
      routeId: "main",
      permissions: [],
      locale: "en",
      nonce: randomUUID(),
    };

    await expect(manager.getPluginUiAsset(session, "request", `/main/app.${assetHash}.js`))
      .rejects.toThrow("content type differs from its manifest");
  });

  test("rejects malformed SSR output at the Manager boundary", async () => {
    const persisted: PluginManifest = {
      ...manifest("1.0.0"),
      ui: { routes: [{ id: "main", path: "/main" }] },
    };
    const manifestHash = await sha256Hex(canonicalJson(persisted));
    const installationId = randomUUID();
    const projectId = randomUUID();
    const prisma = {
      pluginInstallation: {
        findUnique: async () => ({
          projectId,
          pluginId: persisted.id,
          pluginVersion: persisted.version,
          manifestHash,
          state: "enabled",
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
      request: async () => ({ html: "<p>bad</p>", status: 302 }),
    } as unknown as PluginConnection);
    const session: PluginUiSession = {
      sub: randomUUID(),
      projectId,
      installationId,
      pluginId: persisted.id,
      pluginVersion: persisted.version,
      manifestHash,
      routeId: "main",
      permissions: [],
      locale: "en",
      nonce: randomUUID(),
    };

    await expect(manager.renderPluginUi(session, "request", {})).rejects.toThrow("plugin UI output is invalid");
  });
});
