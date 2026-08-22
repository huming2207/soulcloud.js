import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CHAOS_PLUGIN_ID, chaosTestPlugin } from "@soulcloud/plugins";
import { startPluginHost, type PluginHostHandle } from "../src/server";

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

describe("plugin host oRPC WebSocket server", () => {
  test("rejects non-finite resource limits at startup", async () => {
    await expect(startPluginHost({
      pluginId: CHAOS_PLUGIN_ID,
      hostname: "127.0.0.1",
      port: 0,
      valueBudget: { maxNodes: Number.NaN },
    })).rejects.toThrow("valueBudget.maxNodes");
  });

  test("health endpoint reports readiness", async () => {
    const response = await fetch(`${host.url}/health`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      ok: true,
      pluginId: CHAOS_PLUGIN_ID,
      pluginVersion: chaosTestPlugin.version,
    });
  });

  test("only accepts the WebSocket RPC endpoint", async () => {
    const response = await fetch(`${host.url}/rpc`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("authentication rejects an unauthorised WebSocket upgrade", async () => {
    const authHost = await startPluginHost({
      pluginId: CHAOS_PLUGIN_ID,
      hostname: "127.0.0.1",
      port: 0,
      authToken: "test-token-long-enough",
    });
    try {
      const response = await fetch(`${authHost.url}/rpc/ws`, {
        headers: { "x-soulcloud-rpc-protocol": "1" },
      });
      expect(response.status).toBe(401);
    } finally {
      await authHost.close();
    }
  });

  test("WebSocket connection reservations enforce the connection cap", async () => {
    const limitedHost = await startPluginHost({
      pluginId: CHAOS_PLUGIN_ID,
      hostname: "127.0.0.1",
      port: 0,
      maxWebSocketConnections: 1,
    });
    const first = new WebSocket(limitedHost.wsUrl, {
      headers: { "x-soulcloud-rpc-protocol": "1" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        first.addEventListener("open", () => resolve());
        first.addEventListener("error", () => reject(new Error("first WebSocket failed")));
      });
      const response = await fetch(`${limitedHost.url}/rpc/ws`, {
        headers: { "x-soulcloud-rpc-protocol": "1" },
      });
      expect(response.status).toBe(503);
    } finally {
      first.close();
      await limitedHost.close();
    }
  });
});
