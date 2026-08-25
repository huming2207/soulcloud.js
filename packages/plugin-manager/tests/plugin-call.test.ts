import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { PluginManager } from "../src/manager";

const authToken = "plugin-manager-call-test-token-that-is-long-enough";

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function manager(): PluginManager {
  return new PluginManager({
    endpoints: new Map(),
    authToken,
    maxFrameBytes: 1024 * 1024,
    maxPendingRequests: 8,
    backpressureBytes: 1024 * 1024,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 1_000,
    reconnectMs: 1_000,
    maxPluginCallDepth: 2,
  });
}

describe("scoped plugin-to-plugin calls", () => {
  test("routes through a target connection with inherited scope", async () => {
    const targetProjectId = randomUUID();
    const targetInstallationId = randomUUID();
    const targetManifestHash = "b".repeat(64);
    const requestInputs: unknown[] = [];
    const targetConnection = {
      id: "target-connection",
      isOpen: true,
      manifest: {
        pluginId: "target.plugin",
        pluginVersion: "1.0.0",
        manifestHash: targetManifestHash,
      },
      request: async (method: string, input: unknown) => {
        requestInputs.push({ method, input });
        return { ok: true, bytes: new Blob([Uint8Array.of(1, 2)]) };
      },
    };
    const instance = manager() as unknown as Record<string, any>;
    instance.connections.set("target.plugin", targetConnection);
    instance.catalog.set("target.plugin@1.0.0", {
      pluginId: "target.plugin",
      pluginVersion: "1.0.0",
      manifestHash: targetManifestHash,
      manifest: {},
      connected: true,
    });

    const sourceToken = `${randomUUID()}${randomUUID()}`;
    instance.registerOperation("source-operation", {
      kind: "event",
      operationTokenHash: tokenHash(sourceToken),
      connectionId: "source-connection",
      installationId: targetInstallationId,
      projectId: targetProjectId,
      pluginId: "source.plugin",
      pluginVersion: "2.0.0",
      deviceId: randomUUID(),
      userId: randomUUID(),
      deadline: performance.now() + 5_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
      pluginCallDepth: 0,
    });

    const result = await instance.reversePluginCall({
      operationId: "source-operation",
      operationToken: sourceToken,
      deadlineMs: 5_000,
      pluginId: "target.plugin",
      procedure: "echo",
      input: { value: "hello" },
    }, new AbortController().signal, "source-connection");

    expect(result).toEqual({ ok: true, bytes: expect.any(Blob) });
    expect(requestInputs).toHaveLength(1);
    expect(requestInputs[0]).toMatchObject({
      method: "plugin.call",
      input: {
        caller: {
          pluginId: "source.plugin",
          pluginVersion: "2.0.0",
          projectId: targetProjectId,
          installationId: targetInstallationId,
        },
        procedure: "echo",
        input: { value: "hello" },
      },
    });
    expect(instance.operations.size).toBe(1);
    expect(instance.operationsByPlugin.has("target.plugin")).toBe(false);
  });

  test("rejects recursive calls beyond the configured depth", async () => {
    const instance = manager() as unknown as Record<string, any>;
    const sourceToken = `${randomUUID()}${randomUUID()}`;
    instance.registerOperation("deep-operation", {
      kind: "plugin-call",
      operationTokenHash: tokenHash(sourceToken),
      connectionId: "source-connection",
      installationId: randomUUID(),
      projectId: randomUUID(),
      pluginId: "source.plugin",
      pluginVersion: "1.0.0",
      deadline: performance.now() + 5_000,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
      pluginCallDepth: 2,
    });
    await expect(instance.reversePluginCall({
      operationId: "deep-operation",
      operationToken: sourceToken,
      deadlineMs: 5_000,
      pluginId: "target.plugin",
      procedure: "echo",
      input: null,
    }, new AbortController().signal, "source-connection")).rejects.toThrow("depth limit");
    expect(instance.operations.size).toBe(1);
  });
});
