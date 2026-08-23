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
} as unknown as PluginManager;
const server = startPluginManagerServer({ hostname: "127.0.0.1", port: 0, serviceToken: "internal-service-token", manager, uiSessionSecret: secret });
const token = signPluginUiSession({ secret, ttlSeconds: 300 }, {
  sub: randomUUID(), projectId, installationId, pluginId: manifest.id, pluginVersion: manifest.version,
  manifestHash: "a".repeat(64), routeId: "overview", permissions: [], locale: "en",
});
const cookie = `${pluginUiSessionCookieName(installationId)}=${token}`;

afterAll(async () => { await server.stop(); });

describe("plugin SSR route", () => {
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
});
