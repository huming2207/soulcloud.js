import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pluginUiSessionCookieName, signPluginUiSession } from "@soulcloud/core";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import type { PluginManager } from "../src/manager";
import { startPluginManagerServer } from "../src/server";

const installationId = randomUUID();
const projectId = randomUUID();
const secret = "test-plugin-ui-secret-that-is-long-enough";
const manifest: PluginManifest = {
  id: "example.plugin",
  version: "1.0.0",
  apiVersion: 1,
  profiles: [],
  actions: [],
  events: [],
  ui: { routes: [{
    id: "overview",
    path: "/overview",
    methods: ["GET", "POST"],
    querySchema: { count: { type: "integer", required: true } },
    actionSchema: { enabled: { type: "boolean", required: true } },
  }] },
};
let renderedParams: unknown;
let submittedAction: unknown;
let actionTimeout: number | undefined;
let sessionStartInput: unknown;
const consumedGrants = new Set<string>();
const manager = {
  ready: async () => true,
  getManifest: () => manifest,
  renderPluginUi: async (_session: unknown, _requestId: string, params: unknown) => {
    renderedParams = params;
    return { html: "<main>plugin page</main>", title: "Plugin" };
  },
  handlePluginUiAction: async (_session: unknown, _requestId: string, _params: unknown, action: unknown) => {
    submittedAction = action;
    return {};
  },
  encodeAction: async (input: { timeoutMs?: number }) => {
    actionTimeout = input.timeoutMs;
    return { batchId: randomUUID(), deviceCount: 1 };
  },
  startDebugSession: async (input: unknown) => {
    sessionStartInput = input;
    return { execution: { id: randomUUID() }, sessionId: randomUUID() };
  },
  consumePluginUiGrant: async (nonce: string) => {
    if (consumedGrants.has(nonce)) return false;
    consumedGrants.add(nonce);
    return true;
  },
} as unknown as PluginManager;
const server = startPluginManagerServer({ hostname: "127.0.0.1", port: 0, serviceToken: "internal-service-token", manager, uiSessionSecret: secret });
const token = signPluginUiSession({ secret, ttlSeconds: 300 }, {
  sub: randomUUID(), projectId, installationId, pluginId: manifest.id, pluginVersion: manifest.version,
  manifestHash: "a".repeat(64), routeId: "overview", permissions: [], locale: "en",
});
const cookie = `${pluginUiSessionCookieName(installationId)}=${token}`;

afterAll(async () => { await server.stop(); });

describe("plugin SSR route", () => {
  test("consumes a short-lived bootstrap grant once and sets a plugin-origin cookie", async () => {
    const grant = signPluginUiSession({ secret, ttlSeconds: 300 }, {
      sub: randomUUID(), projectId, installationId, pluginId: manifest.id, pluginVersion: manifest.version,
      manifestHash: "a".repeat(64), routeId: "overview", permissions: [], locale: "en",
    });
    const response = await fetch(`${server.url}bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap_token: grant }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/plugins/${installationId}/overview`);
    expect(response.headers.get("set-cookie")).toContain(`Path=/plugins/${installationId}/`);
    const replay = await fetch(`${server.url}bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap_token: grant }),
    });
    expect(replay.status).toBe(401);
  });

  test("requires the path-scoped UI session cookie", async () => {
    const response = await fetch(`${server.url}plugins/${installationId}/overview?count=3`);
    expect(response.status).toBe(401);
  });

  test("validates and coerces query parameters", async () => {
    const response = await fetch(`${server.url}plugins/${installationId}/overview?count=3`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("plugin page");
    expect(renderedParams).toEqual({ count: 3 });
  });

  test("accepts ordinary form posts and validates the action schema", async () => {
    const response = await fetch(`${server.url}plugins/${installationId}/overview?count=3`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=true",
    });
    expect(response.status).toBe(200);
    expect(submittedAction).toEqual({ enabled: true });
  });

  test("reports invalid plugin UI output as a 502 plugin error", async () => {
    const failingManager = {
      ...manager,
      ready: async () => true,
      getManifest: () => manifest,
      renderPluginUi: async () => {
        throw Object.assign(new Error("INVALID_PLUGIN_OUTPUT: invalid status"), {
          status: 502,
          publicCode: "plugin_ui_invalid_output",
        });
      },
    } as unknown as PluginManager;
    const failingServer = startPluginManagerServer({
      hostname: "127.0.0.1",
      port: 0,
      serviceToken: "internal-service-token",
      manager: failingManager,
      uiSessionSecret: secret,
    });
    try {
      const response = await fetch(`${failingServer.url}plugins/${installationId}/overview?count=3`, {
        headers: { cookie },
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: "plugin_ui_invalid_output" });
    } finally {
      await failingServer.stop();
    }
  });

  test("strictly rejects malformed internal lifecycle input", async () => {
    const response = await fetch(`${server.url}internal/plugins/installations/${installationId}/state`, {
      method: "POST",
      headers: { authorization: "Bearer internal-service-token", "content-type": "application/json" },
      body: JSON.stringify({ state: "enable" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  test("passes the internal Action deadline to the plugin operation", async () => {
    const response = await fetch(`${server.url}internal/plugins/actions/encode`, {
      method: "POST",
      headers: { authorization: "Bearer internal-service-token", "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        userId: randomUUID(),
        deviceId: randomUUID(),
        actionId: "run",
        input: {},
        timeoutMs: 4_000,
      }),
    });
    expect(response.status).toBe(200);
    expect(actionTimeout).toBe(4_000);
  });

  test("starts a debugger session without returning an execution token", async () => {
    const response = await fetch(`${server.url}internal/plugins/debugger/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer internal-service-token", "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        projectId,
        deviceId: randomUUID(),
        userId: randomUUID(),
        caseId: randomUUID(),
        targetConfigId: randomUUID(),
        targetConfigRevision: 1,
        targetId: "fixture",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("executionToken");
    expect(sessionStartInput).toMatchObject({ installationId, projectId, caseId: expect.any(String), leaseMs: 60_000, ttlMs: 86_400_000 });
  });
});
