import { afterAll, beforeAll, expect, test } from "bun:test";
import { CHAOS_PLUGIN_ID, chaosTestPlugin } from "@soulcloud/plugins";
import { startPluginHost, type PluginHostHandle } from "../../plugin-host/src/server";
import { PluginHostClient } from "../src/rpc-client";

let host: PluginHostHandle;

beforeAll(async () => {
  host = await startPluginHost({
    pluginId: CHAOS_PLUGIN_ID,
    hostname: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await host.close();
});

test("oRPC WebSocket client performs handshake, event and action calls", async () => {
  const reverseCalls: string[] = [];
  const client = await PluginHostClient.connect({
    baseUrl: host.wsUrl,
    reverseHandlers: {
      async entityGet(input) {
        reverseCalls.push(`get:${input.entityKey}`);
        return {
          entityKey: input.entityKey,
          value: 7,
          quality: "good",
          sourceTimestamp: null,
          ingestedAt: new Date().toISOString(),
          alarm: null,
        };
      },
      async commandEnqueue(input) {
        reverseCalls.push(`command:${input.command}`);
        return { ok: true };
      },
    },
  });
  try {
    await client.handshake({
      pluginId: CHAOS_PLUGIN_ID,
      pluginVersion: chaosTestPlugin.version,
      apiVersion: chaosTestPlugin.apiVersion,
    });
    const event = await client.request("plugin.handleEvent", {
      operationId: crypto.randomUUID(),
      operationToken: "0123456789abcdef0123456789abcdef",
      eventId: crypto.randomUUID(),
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 42 },
      device: {
        id: crypto.randomUUID(),
        deviceUid: "ws-test-device",
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
      },
      installation: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), config: {} },
      receivedAt: new Date().toISOString(),
    }, 5_000);
    const typedEvent = event as { updates: Array<{ entityKey: string; value: unknown }> };
    expect(typedEvent.updates).toEqual([
      { entityKey: "chaos.counter", value: 42 },
      { entityKey: "chaos.last_kind", value: "ok" },
    ]);

    await client.request("plugin.handleEvent", {
      operationId: crypto.randomUUID(),
      operationToken: "0123456789abcdef0123456789abcdef",
      eventId: crypto.randomUUID(),
      eventKind: "reverse",
      schemaVersion: 1,
      payload: {},
      device: {
        id: crypto.randomUUID(),
        deviceUid: "ws-test-device",
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
      },
      installation: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), config: {} },
      receivedAt: new Date().toISOString(),
    }, 5_000);
    expect(reverseCalls).toEqual(["get:chaos.counter", "command:chaos_reverse"]);

    const encoded = await client.request("action.encode", {
      operationId: crypto.randomUUID(),
      operationToken: "0123456789abcdef0123456789abcdef",
      actionId: "set_mode",
      input: { mode: "running", threshold: 7 },
    }, 5_000) as { cmd: string; args: unknown[]; schemaVersion: number };
    expect(encoded).toEqual({
      cmd: "chaos_set_mode",
      args: [
        { name: "mode", value: "running" },
        { name: "threshold", value: 7 },
      ],
      schemaVersion: 1,
    });
  } finally {
    client.close();
  }
});
