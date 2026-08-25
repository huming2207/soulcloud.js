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
});
