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
        entities: [{ key: "temperature", valueType: "number", category: "measurement" }],
      }],
      actions: [{ id: "reboot", inputSchema: {}, wire: { command: "reboot", schemaVersion: 1 } }],
      events: [{ kind: "reading", schemaVersion: 1 }],
    },
    encodeAction: { reboot: () => [] },
    onEvent: async (context) => {
      await context.getEntity("temperature");
      await context.enqueueCommand("acknowledge");
      return { updates: [{ entityKey: "temperature", value: 24 }] };
    },
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
        return null;
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
  test("handshakes and encodes an action", async () => {
    expect(connection.manifest?.pluginVersion).toBe("1.0.0");
    const output = await connection.request("action.encode", {
      operationId: randomUUID(),
      operationToken: `${randomUUID()}${randomUUID()}`,
      actionId: "reboot",
      input: {},
    }, 1_000) as { command: string };
    expect(output.command).toBe("reboot");
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
    }, 1_000) as { updates: Array<{ entityKey: string }> };
    expect(output.updates[0]?.entityKey).toBe("temperature");
    expect(reverseEntityKey).toBe("temperature");
    expect(reverseCommand).toBe("acknowledge");
  });
});
