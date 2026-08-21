import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HANDSHAKE_METHOD,
  HANDLE_EVENT_METHOD,
  ENCODE_ACTION_METHOD,
  RPC_CONTENT_TYPE,
  RPC_VERSION,
  decodeRpcMessage,
  encodeRpcMessage,
  isRpcResponse,
  type HandleEventParams,
  type HandleEventResult,
  type RpcResponse,
} from "@soulcloud/plugin-sdk";
import { CHAOS_PLUGIN_ID, chaosTestPlugin } from "@soulcloud/plugins";
import { startPluginHost, type PluginHostHandle } from "../src/server";

class TestClient {
  constructor(private readonly baseUrl: string) {}

  async request(
    method: string,
    params: unknown,
    deadlineMs = 5_000,
  ): Promise<RpcResponse> {
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": RPC_CONTENT_TYPE },
      body: encodeRpcMessage({ version: RPC_VERSION, id: 1, method, params, deadlineMs }),
    });
    const decoded = decodeRpcMessage(new Uint8Array(await response.arrayBuffer()));
    if (!isRpcResponse(decoded)) throw new Error("invalid test RPC response");
    return decoded;
  }
}

function eventParams(
  overrides: Partial<HandleEventParams> = {},
): HandleEventParams {
  return {
    eventId: crypto.randomUUID(),
    eventKind: "ok",
    schemaVersion: 1,
    payload: {},
    device: {
      id: crypto.randomUUID(),
      deviceUid: "host-test-device",
      profileId: chaosTestPlugin.profiles[0]!.id,
      profileVersion: chaosTestPlugin.profiles[0]!.version,
    },
    installation: {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      config: {},
    },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

function client(): TestClient {
  return new TestClient(host.url);
}

describe("plugin host HTTP MessagePack-RPC", () => {
  test("health endpoint reports readiness", async () => {
    const response = await fetch(`${host.url}/health`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ ok: true, pluginId: CHAOS_PLUGIN_ID });
  });

  test("handshake reports the plugin identity", async () => {
    const response = await client().request(HANDSHAKE_METHOD, { rpcVersion: RPC_VERSION });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        rpcVersion: RPC_VERSION,
        pluginId: CHAOS_PLUGIN_ID,
        pluginVersion: chaosTestPlugin.version,
        apiVersion: 1,
      });
    }
  });

  test("unknown methods are rejected", async () => {
    const response = await client().request("no.such.method", {});
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("method_not_found");
  });

  test("handleEvent returns validated updates", async () => {
    const response = await client().request(
      HANDLE_EVENT_METHOD,
      eventParams({ eventKind: "ok", payload: { value: 42 } }),
    );
    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as HandleEventResult & { logs?: unknown[] };
      expect(result.updates).toEqual([
        { entityKey: "chaos.counter", value: 42 },
        { entityKey: "chaos.last_kind", value: "ok" },
      ]);
      expect(result.logs).toEqual([]);
    }
  });

  test("action encoding returns the declared command over MessagePack-RPC", async () => {
    const response = await client().request(ENCODE_ACTION_METHOD, {
      actionId: "set_mode",
      input: { mode: "running", threshold: 7 },
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        cmd: "chaos_set_mode",
        args: [{ mode: "running" }, { threshold: 7 }],
        schemaVersion: 1,
      });
    }
  });

  test("handler errors surface as handler_error", async () => {
    const response = await client().request(
      HANDLE_EVENT_METHOD,
      eventParams({ eventKind: "fail" }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("handler_error");
      expect(response.error.message).toContain("chaos failure");
    }
  });

  test("invalid plugin output is rejected by the host pre-check", async () => {
    const response = await client().request(
      HANDLE_EVENT_METHOD,
      eventParams({
        eventKind: "updates",
        payload: { updates: [{ entityKey: "chaos.nope", value: 1 }] },
      }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid_params");
      expect(response.error.message).toContain("chaos.nope");
    }
  });

  test("oversized responses are rejected as response_too_large", async () => {
    const tinyHost = await startPluginHost({
      pluginId: CHAOS_PLUGIN_ID,
      hostname: "127.0.0.1",
      port: 0,
      maxFrameBytes: 8192,
    });
    try {
      const response = await new TestClient(tinyHost.url).request(
        HANDLE_EVENT_METHOD,
        eventParams({ eventKind: "bulky" }),
      );
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe("response_too_large");
    } finally {
      await tinyHost.close();
    }
  });

  test("unknown event kinds are handler errors", async () => {
    const response = await client().request(
      HANDLE_EVENT_METHOD,
      eventParams({ eventKind: "not-a-kind" }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("handler_error");
  });

  test("authentication rejects requests without the configured token", async () => {
    const authHost = await startPluginHost({
      pluginId: CHAOS_PLUGIN_ID,
      hostname: "127.0.0.1",
      port: 0,
      authToken: "test-token-long-enough",
    });
    try {
      const response = await fetch(`${authHost.url}/rpc`, {
        method: "POST",
        headers: { "content-type": RPC_CONTENT_TYPE },
        body: encodeRpcMessage({
          version: RPC_VERSION,
          id: 1,
          method: HANDSHAKE_METHOD,
          params: {},
          deadlineMs: 1000,
        }),
      });
      expect(response.status).toBe(401);
    } finally {
      await authHost.close();
    }
  });
});
