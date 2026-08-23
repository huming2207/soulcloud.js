import { describe, expect, test } from "bun:test";
import { pluginUiSessionCookieName, signPluginUiSession, verifyPluginUiSession } from "../../src/auth/plugin-ui-session";

const config = { secret: "test-plugin-ui-secret-that-is-long-enough", ttlSeconds: 300 };

describe("plugin UI session", () => {
  test("round-trips scoped claims with a generated nonce", () => {
    const token = signPluginUiSession(config, {
      sub: "user",
      projectId: "project",
      installationId: "11111111-1111-1111-1111-111111111111",
      pluginId: "example.plugin",
      pluginVersion: "1.0.0",
      manifestHash: "a".repeat(64),
      routeId: "overview",
      permissions: [],
      locale: "en",
    });
    const session = verifyPluginUiSession(config, token);
    expect(session.routeId).toBe("overview");
    expect(session.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("uses a cookie name scoped by installation", () => {
    expect(pluginUiSessionCookieName("11111111-2222-3333-4444-555555555555"))
      .toBe("soulcloud_plugin_ui_11111111222233334444555555555555");
  });
});
