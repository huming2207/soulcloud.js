import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { splitArtifactBody } from "../src/manager";
import { PluginManager } from "../src/manager";

describe("plugin artifact upload body", () => {
  test("stops reading a stalled body at the absolute upload deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true; },
    });
    const read = (async () => {
      for await (const _chunk of splitArtifactBody(body, performance.now() + 10)) {
        // The body never yields a chunk.
      }
    })();

    await expect(read).rejects.toMatchObject({ status: 504, publicCode: "plugin_timeout" });
    expect(cancelled).toBe(true);
  });

  test("splits a body into bounded chunks", async () => {
    const first = Uint8Array.from({ length: 65_536 }, (_, index) => index & 0xff);
    const second = Uint8Array.of(1, 2, 3);
    const chunks: Uint8Array[] = [];
    for await (const chunk of splitArtifactBody(new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    }), performance.now() + 1_000)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(first);
    expect(chunks[1]).toEqual(second);
  });

  test("returns the existing artifact when a retry sees a completed upload", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const pluginId = "fixture.plugin";
    const pluginVersion = "1.0.0";
    const manifestHash = "a".repeat(64);
    const uploadId = randomUUID();
    const artifactId = randomUUID();
    const calls: unknown[] = [];
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "test-plugin-rpc-token-that-is-long-enough",
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      artifactUploadTimeoutMs: 1_000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => ({ id: installationId, projectId, pluginId, pluginVersion, manifestHash, state: "enabled" }),
        },
      } as never,
    });
    const connection = {
      id: "connection-1",
      isOpen: true,
      manifest: { pluginVersion, manifestHash },
      request: async (_method: string, input: { uploadId: string }) => {
        calls.push(input);
        return { uploadId: input.uploadId, receivedBytes: 65_537, complete: true, artifactId, sha256: "b".repeat(64) };
      },
    };
    const managerState = manager as unknown as { connections: Map<string, unknown>; catalog: Map<string, unknown> };
    managerState.connections.set(pluginId, connection);
    managerState.catalog.set(`${pluginId}@${pluginVersion}`, {
      pluginId,
      pluginVersion,
      manifestHash,
      manifest: { id: pluginId, version: pluginVersion, apiVersion: 1, profiles: [], actions: [], events: [] },
      connected: true,
    });

    const result = await manager.uploadArtifact({
      installationId,
      projectId,
      userId: randomUUID(),
      uploadId,
      kind: "firmware",
      filename: "fixture.bin",
      contentType: "application/octet-stream",
      totalSize: 65_537,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65_537));
          controller.close();
        },
      }),
    });

    expect(result).toEqual({ uploadId, artifactId, sha256: "b".repeat(64), size: 65_537, kind: "firmware", filename: "fixture.bin" });
    expect(calls).toHaveLength(1);
  });

  test("rejects a plugin artifact response for a different upload", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const pluginId = "fixture.plugin";
    const pluginVersion = "1.0.0";
    const manifestHash = "a".repeat(64);
    const uploadId = randomUUID();
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "test-plugin-rpc-token-that-is-long-enough",
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => ({ id: installationId, projectId, pluginId, pluginVersion, manifestHash, state: "enabled" }),
        },
      } as never,
    });
    const connection = {
      id: "connection-1",
      isOpen: true,
      manifest: { pluginVersion, manifestHash },
      request: async () => ({ uploadId: randomUUID(), receivedBytes: 1, complete: true, artifactId: randomUUID(), sha256: "b".repeat(64) }),
    };
    const managerState = manager as unknown as { connections: Map<string, unknown>; catalog: Map<string, unknown> };
    managerState.connections.set(pluginId, connection);
    managerState.catalog.set(`${pluginId}@${pluginVersion}`, {
      pluginId,
      pluginVersion,
      manifestHash,
      manifest: { id: pluginId, version: pluginVersion, apiVersion: 1, profiles: [], actions: [], events: [] },
      connected: true,
    });

    await expect(manager.uploadArtifact({
      installationId,
      projectId,
      userId: randomUUID(),
      uploadId,
      kind: "firmware",
      filename: "fixture.bin",
      contentType: "application/octet-stream",
      totalSize: 1,
      body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); } }),
    })).rejects.toMatchObject({ status: 502, publicCode: "invalid_plugin_output" });
  });

  test("pins a UI upload to the session's plugin snapshot", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const pluginId = "fixture.plugin";
    const pluginVersion = "1.0.0";
    const manifestHash = "a".repeat(64);
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "test-plugin-rpc-token-that-is-long-enough",
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => ({ id: installationId, projectId, pluginId, pluginVersion, manifestHash, state: "enabled" }),
        },
      } as never,
    });
    await expect(manager.uploadArtifact({
      installationId,
      projectId,
      userId,
      uploadId: randomUUID(),
      kind: "firmware",
      filename: "fixture.bin",
      contentType: "application/octet-stream",
      totalSize: 1,
      body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); } }),
      uiSession: {
        installationId,
        projectId,
        sub: userId,
        pluginId,
        pluginVersion: "0.9.0",
        manifestHash,
      },
    })).rejects.toMatchObject({ status: 403, publicCode: "plugin_ui_session_invalid" });
  });

  test("revalidates a UI upload snapshot after the final chunk", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const pluginId = "fixture.plugin";
    const pluginVersion = "1.0.0";
    const manifestHash = "a".repeat(64);
    let installationReads = 0;
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "test-plugin-rpc-token-that-is-long-enough",
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => {
            installationReads += 1;
            return installationReads === 1
              ? { id: installationId, projectId, pluginId, pluginVersion, manifestHash, state: "enabled" }
              : { id: installationId, projectId, pluginId, pluginVersion: "2.0.0", manifestHash, state: "enabled" };
          },
        },
      } as never,
    });
    const connection = {
      id: "connection-1",
      isOpen: true,
      manifest: { pluginVersion, manifestHash },
      request: async (_method: string, input: { uploadId: string; offset: number; chunk: Uint8Array; final: boolean }) => ({
        uploadId: input.uploadId,
        receivedBytes: input.offset + input.chunk.byteLength,
        complete: input.final,
        artifactId: input.final ? randomUUID() : null,
        sha256: input.final ? "b".repeat(64) : null,
      }),
    };
    const managerState = manager as unknown as { connections: Map<string, unknown>; catalog: Map<string, unknown> };
    managerState.connections.set(pluginId, connection);
    managerState.catalog.set(`${pluginId}@${pluginVersion}`, {
      pluginId,
      pluginVersion,
      manifestHash,
      manifest: { id: pluginId, version: pluginVersion, apiVersion: 1, profiles: [], actions: [], events: [] },
      connected: true,
    });

    await expect(manager.uploadArtifact({
      installationId,
      projectId,
      userId,
      uploadId: randomUUID(),
      kind: "firmware",
      filename: "fixture.bin",
      contentType: "application/octet-stream",
      totalSize: 1,
      body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); } }),
      uiSession: { installationId, projectId, sub: userId, pluginId, pluginVersion, manifestHash },
    })).rejects.toMatchObject({ status: 403, publicCode: "plugin_ui_session_invalid" });
    expect(installationReads).toBe(2);
  });

  test("revalidates an internal upload snapshot before accepting the final chunk", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const pluginId = "fixture.plugin";
    const manifestHash = "a".repeat(64);
    let installationReads = 0;
    let pluginCalls = 0;
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "test-plugin-rpc-token-that-is-long-enough",
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      prisma: {
        pluginInstallation: {
          findUnique: async () => {
            installationReads += 1;
            return installationReads === 1
              ? { id: installationId, projectId, pluginId, pluginVersion: "1.0.0", manifestHash, state: "enabled" }
              : { id: installationId, projectId, pluginId, pluginVersion: "2.0.0", manifestHash, state: "enabled" };
          },
        },
      } as never,
    });
    const connection = {
      id: "connection-1",
      isOpen: true,
      manifest: { pluginVersion: "1.0.0", manifestHash },
      request: async () => { pluginCalls += 1; return { uploadId: randomUUID(), receivedBytes: 1, complete: true, artifactId: randomUUID(), sha256: "b".repeat(64) }; },
    };
    const managerState = manager as unknown as { connections: Map<string, unknown>; catalog: Map<string, unknown> };
    managerState.connections.set(pluginId, connection);
    managerState.catalog.set(`${pluginId}@1.0.0`, {
      pluginId,
      pluginVersion: "1.0.0",
      manifestHash,
      manifest: { id: pluginId, version: "1.0.0", apiVersion: 1, profiles: [], actions: [], events: [] },
      connected: true,
    });

    await expect(manager.uploadArtifact({
      installationId,
      projectId,
      userId: randomUUID(),
      uploadId: randomUUID(),
      kind: "firmware",
      filename: "fixture.bin",
      contentType: "application/octet-stream",
      totalSize: 1,
      body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); } }),
    })).rejects.toMatchObject({ status: 409, publicCode: "conflict" });
    expect(installationReads).toBe(2);
    expect(pluginCalls).toBe(0);
  });
});
