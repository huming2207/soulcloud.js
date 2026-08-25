import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { definePlugin } from "@soulcloud/plugin-sdk";
import { startPluginRuntime, type PluginRuntimeHandle } from "@soulcloud/plugin-runtime/server";
import { PluginConnection } from "../src/connection";

const authToken = "test-plugin-rpc-token-that-is-long-enough";
let runtime: PluginRuntimeHandle;
let connection: PluginConnection;
let reverseEntityKey: string | undefined;
let reverseCommand: string | undefined;
let reverseEntityValue: unknown;
let uiInputHasOperationProof = false;
let eventPayloadValue: unknown;

beforeAll(async () => {
  runtime = await startPluginRuntime(definePlugin({
    manifest: {
      id: "integration.plugin",
      version: "1.0.0",
      apiVersion: 1,
      profiles: [{
        id: "fixture",
        version: 1,
        manufacturer: "Soulcloud",
        model: "fixture",
        capabilities: [],
        entities: [
          { key: "temperature", valueType: "number", category: "measurement" },
          { key: "capture", valueType: "binary", category: "diagnostic" },
        ],
      }],
      actions: [{ id: "reboot", inputSchema: {}, wire: { command: "reboot", schemaVersion: 1 } }],
      events: [{ kind: "reading", schemaVersion: 1 }],
      ui: { routes: [{ id: "main", path: "/main" }], assets: [{ path: "/main/app.f75c6596507878933aa2bc17dfd9a8689ad0da4f85427ba457666ae5917fa631.js", contentType: "text/javascript; charset=utf-8", sha256: "f75c6596507878933aa2bc17dfd9a8689ad0da4f85427ba457666ae5917fa631" }] },
    },
    encodeAction: { reboot: () => [{ delay: 3n }] },
    onEvent: async (context, event) => {
      eventPayloadValue = event.payload;
      reverseEntityValue = await context.getEntity("temperature");
      await context.enqueueCommand("acknowledge");
      return {
        updates: [
          { entityKey: "temperature", value: 24 },
          { entityKey: "capture", value: Uint8Array.of(1, 2, 3) },
        ],
      };
    },
    handleCall: {
      echo: async (input, context) => ({ input, caller: context.caller }),
    },
    render: {
      main: async (input) => {
        uiInputHasOperationProof = "operationToken" in input || "deadlineMs" in input;
        return { html: "<p>Plugin</p>" };
      },
    },
    assets: {
      "/main/app.f75c6596507878933aa2bc17dfd9a8689ad0da4f85427ba457666ae5917fa631.js": async () => ({ body: Uint8Array.of(99, 111, 110, 115, 116), contentType: "text/javascript; charset=utf-8", cache: "no-store" }),
    },
    configureTarget: async () => ({ configId: randomUUID(), revision: 1, sha256: "a".repeat(64), targetCount: 1 }),
    listTargetConfigs: async () => [{ configId: randomUUID(), revision: 1, sha256: "a".repeat(64), targetCount: 1, createdAt: new Date(0).toISOString() }],
    listArtifacts: async () => [{ artifactId: randomUUID(), kind: "elf" as const, filename: "fixture.elf", contentType: "application/octet-stream", size: 4, sha256: "c".repeat(64), createdAt: new Date(0).toISOString() }],
    storeArtifactChunk: async (input) => ({ uploadId: input.uploadId, receivedBytes: input.offset + input.chunk.byteLength, complete: input.final, artifactId: input.final ? randomUUID() : null, sha256: input.final ? "b".repeat(64) : null }),
  }), { hostname: "127.0.0.1", port: 0, authToken });

  connection = new PluginConnection({
    pluginId: "integration.plugin",
    endpoint: runtime.url.replace(/^http/, "ws"),
    authToken,
    maxFrameBytes: 1024 * 1024,
    maxPendingRequests: 8,
    backpressureBytes: 1024 * 1024,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 1_000,
    reverseHandlers: {
      entityGet: async (input) => {
        reverseEntityKey = input.entityKey;
        return {
          entityKey: input.entityKey,
          value: new Blob([Uint8Array.of(4, 5, 6)]),
          quality: "good",
          sourceTimestamp: null,
          ingestedAt: new Date(0).toISOString(),
          alarm: null,
        };
      },
      commandEnqueue: async (input) => {
        reverseCommand = input.command;
        return { accepted: true };
      },
      pluginCall: async () => { throw new Error("not used"); },
      uiGetData: async () => { throw new Error("not used"); },
    },
  });
  await connection.connect();
});

afterAll(async () => {
  connection.close();
  await runtime.close();
});

describe("plugin oRPC WebSocket transport", () => {
  test("rejects an outbound frame before it exceeds the configured limit", async () => {
    const limited = new PluginConnection({
      pluginId: "integration.plugin",
      endpoint: runtime.url.replace(/^http/, "ws"),
      authToken,
      maxFrameBytes: 1,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reverseHandlers: {
        entityGet: async () => null,
        commandEnqueue: async () => ({ accepted: true }),
        pluginCall: async () => null,
        uiGetData: async () => null,
      },
    });
    try {
      await expect(limited.connect()).rejects.toThrow("frame is too large");
    } finally {
      limited.close();
    }
  });

  test("handshakes and encodes an action", async () => {
    expect(connection.manifest?.pluginVersion).toBe("1.0.0");
    const output = await connection.request("action.encode", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      installationId: randomUUID(),
      projectId: randomUUID(),
      deviceId: randomUUID(),
      userId: randomUUID(),
      actionId: "reboot",
      input: {},
    }, 1_000) as { command: string; args: Array<{ name: string; value: bigint }> };
    expect(output.command).toBe("reboot");
    expect(output.args).toEqual([{ name: "delay", value: 3n }]);
  });

  test("routes an explicitly declared plugin procedure with scoped caller context", async () => {
    const caller = {
      pluginId: "caller.plugin",
      pluginVersion: "2.0.0",
      projectId: randomUUID(),
      installationId: randomUUID(),
      deviceId: randomUUID(),
      userId: randomUUID(),
    };
    const output = await connection.request("plugin.call", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      caller,
      procedure: "echo",
      input: { bytes: Uint8Array.of(1, 2, 3) },
    }, 1_000) as { input: { bytes: Blob }; caller: typeof caller };
    expect(output.caller).toEqual(caller);
    expect(output.input.bytes).toBeInstanceOf(Blob);
    expect(new Uint8Array(await output.input.bytes.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  });

  test("routes target configuration through the typed plugin procedure", async () => {
    const output = await connection.request("debugger.configureTarget", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      installationId: randomUUID(),
      projectId: randomUUID(),
      userId: randomUUID(),
      yaml: "version: 1\ntargets:\n  - id: fixture\n    displayName: Fixture\n    architecture: cortex-m\n    chip: fixture\n    transport: swd\n    requiredPrimitives: [identify]",
    }, 1_000);
    expect(output).toMatchObject({ revision: 1, targetCount: 1 });
  });

  test("routes target configuration revision metadata through the typed plugin procedure", async () => {
    const output = await connection.request("debugger.listTargetConfigs", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      installationId: randomUUID(),
      projectId: randomUUID(),
      userId: randomUUID(),
    }, 1_000) as Array<{ revision: number; targetCount: number }>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ revision: 1, targetCount: 1 });
  });

  test("routes artifact metadata without moving artifact bytes through the listing procedure", async () => {
    const output = await connection.request("debugger.listArtifacts", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      installationId: randomUUID(),
      projectId: randomUUID(),
      userId: randomUUID(),
    }, 1_000) as Array<{ kind: string; filename: string; size: number }>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ kind: "elf", filename: "fixture.elf", size: 4 });
    expect(output[0]).not.toHaveProperty("content");
  });

  test("keeps artifact chunks binary and bounded", async () => {
    const uploadId = randomUUID();
    const output = await connection.request("debugger.storeArtifactChunk", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      installationId: randomUUID(),
      projectId: randomUUID(),
      userId: randomUUID(),
      uploadId,
      kind: "firmware",
      filename: "image.bin",
      contentType: "application/octet-stream",
      totalSize: 3,
      offset: 0,
      final: true,
      chunk: Uint8Array.of(1, 2, 3),
    }, 1_000) as { uploadId: string; receivedBytes: number; complete: boolean; artifactId: string | null };
    expect(output.uploadId).toBe(uploadId);
    expect(output.receivedBytes).toBe(3);
    expect(output.complete).toBe(true);
    expect(output.artifactId).toBeString();
  });

  test("routes reverse calls on the same socket", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const deviceId = randomUUID();
    const output = await connection.request("plugin.handleEvent", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      event: { id: "00".repeat(16), seq: 1n, kind: "reading", schema: 1, receivedAt: new Date().toISOString(), payload: { value: 24 } },
      installation: { id: installationId, projectId, pluginId: "integration.plugin", pluginVersion: "1.0.0", config: null },
      device: { id: deviceId, uid: "fixture-1", profileId: "fixture", profileVersion: 1 },
    }, 1_000) as { updates: Array<{ entityKey: string; value: unknown }> };
    expect(output.updates[0]?.entityKey).toBe("temperature");
    expect(output.updates[1]?.value).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (output.updates[1]!.value as Blob).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(reverseEntityKey).toBe("temperature");
    expect((reverseEntityValue as { value: unknown }).value).toEqual(Uint8Array.of(4, 5, 6));
    expect(reverseCommand).toBe("acknowledge");
  });

  test("restores binary device event payloads across the RPC adapter", async () => {
    const installationId = randomUUID();
    const projectId = randomUUID();
    const deviceId = randomUUID();
    const base = {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      event: {
        id: "00".repeat(16),
        seq: 1n,
        kind: "reading",
        schema: 1,
        receivedAt: new Date().toISOString(),
      },
      installation: { id: installationId, projectId, pluginId: "integration.plugin", pluginVersion: "1.0.0", config: null },
      device: { id: deviceId, uid: "fixture-1", profileId: "fixture", profileVersion: 1 },
    };

    await connection.request("plugin.handleEvent", {
      ...base,
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      event: { ...base.event, payload: Uint8Array.of(7, 8, 9) },
    }, 1_000);
    expect(eventPayloadValue).toEqual(Uint8Array.of(7, 8, 9));
    expect(eventPayloadValue).toBeInstanceOf(Uint8Array);

    await connection.request("plugin.handleEvent", {
      ...base,
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      event: {
        ...base.event,
        payload: {
          samples: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)],
          flags: { ready: true },
        },
      },
    }, 1_000);
    const nested = eventPayloadValue as { samples: Uint8Array[]; flags: { ready: boolean } };
    expect(nested.flags).toEqual({ ready: true });
    expect(nested.samples).toHaveLength(2);
    expect(nested.samples[0]).toEqual(Uint8Array.of(1, 2, 3));
    expect(nested.samples[0]).toBeInstanceOf(Uint8Array);
    expect(nested.samples[1]).toEqual(Uint8Array.of(4, 5));
    expect(nested.samples[1]).toBeInstanceOf(Uint8Array);
  });

  test("does not expose wire operation proofs to plugin UI code", async () => {
    const output = await connection.request("ui.render", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      requestId: randomUUID(),
      routeId: "main",
      installationId: randomUUID(),
      projectId: randomUUID(),
      user: { id: randomUUID(), locale: "en", permissions: [] },
      params: {},
    }, 1_000) as { html: string };
    expect(output.html).toBe("<p>Plugin</p>");
    expect(uiInputHasOperationProof).toBe(false);
  });

  test("serves a declared UI asset over the same typed RPC connection", async () => {
    const output = await connection.request("ui.asset", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      requestId: randomUUID(),
      routeId: "main",
      assetPath: "/main/app.f75c6596507878933aa2bc17dfd9a8689ad0da4f85427ba457666ae5917fa631.js",
      installationId: randomUUID(),
      projectId: randomUUID(),
      user: { id: randomUUID(), locale: "en", permissions: [] },
    }, 1_000) as { body: Blob; contentType: string };
    expect(output.contentType).toBe("text/javascript; charset=utf-8");
    expect(new Uint8Array(await output.body.arrayBuffer())).toEqual(Uint8Array.of(99, 111, 110, 115, 116));
  });

  test("shares the operation limit across WebSocket connections", async () => {
    let handlerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
    let releaseHandler!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const limitedRuntime = await startPluginRuntime(definePlugin({
      manifest: {
        id: "limited.plugin",
        version: "1.0.0",
        apiVersion: 1,
        profiles: [{
          id: "fixture",
          version: 1,
          manufacturer: "Soulcloud",
          model: "fixture",
          capabilities: [],
          entities: [],
        }],
        actions: [],
        events: [{ kind: "reading", schemaVersion: 1 }],
      },
      onEvent: async () => {
        handlerEntered();
        await blocked;
        return {};
      },
    }), { hostname: "127.0.0.1", port: 0, authToken, maxConcurrentOperations: 1 });
    const connectionOptions = {
      pluginId: "limited.plugin",
      endpoint: limitedRuntime.url.replace(/^http/, "ws"),
      authToken,
      maxFrameBytes: 1024 * 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024 * 1024,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reverseHandlers: {
        entityGet: async () => null,
        commandEnqueue: async () => ({ accepted: true as const }),
        pluginCall: async () => null,
        uiGetData: async () => null,
      },
    };
    const first = new PluginConnection(connectionOptions);
    const second = new PluginConnection(connectionOptions);
    try {
      await Promise.all([first.connect(), second.connect()]);
      const eventInput = {
        operationId: randomUUID(),
        operationToken: `${randomUUID()}${randomUUID()}`,
        event: { id: "00".repeat(16), seq: 1n, kind: "reading", schema: 1, receivedAt: new Date().toISOString(), payload: null },
        installation: { id: randomUUID(), projectId: randomUUID(), pluginId: "limited.plugin", pluginVersion: "1.0.0", config: null },
        device: { id: randomUUID(), uid: "fixture-1", profileId: "fixture", profileVersion: 1 },
      };
      const firstRequest = first.request("plugin.handleEvent", eventInput, 1_000);
      await entered;
      await expect(second.request("plugin.handleEvent", {
        ...eventInput,
        operationId: randomUUID(),
        operationToken: `${randomUUID()}${randomUUID()}`,
      }, 1_000)).rejects.toThrow("OVERLOADED");
      releaseHandler();
      await firstRequest;
    } finally {
      releaseHandler();
      first.close();
      second.close();
      await limitedRuntime.close();
    }
  });
});
