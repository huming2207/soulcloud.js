import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pluginUiSessionCookieName, signPluginUiSession, verifyPluginUiSession, consumePluginUiGrant } from "../../src/auth/plugin-ui-session";
import type { PrismaClient } from "../../src/db";

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

  test("consumes each bootstrap nonce once and rejects expired grants", async () => {
    const consumed = new Set<string>();
    const fakePrisma = {
      $queryRaw: async (_strings: TemplateStringsArray, nonce: string, expiry: Date) => {
        if (expiry.getTime() <= Date.now() || consumed.has(nonce)) return [];
        consumed.add(nonce);
        return [{ nonce }];
      },
    } as unknown as PrismaClient;
    const nonce = randomUUID();
    expect(await consumePluginUiGrant(fakePrisma, nonce, new Date(Date.now() + 60_000))).toBe(true);
    expect(await consumePluginUiGrant(fakePrisma, nonce, new Date(Date.now() + 60_000))).toBe(false);
    expect(await consumePluginUiGrant(fakePrisma, randomUUID(), new Date(Date.now() - 1_000))).toBe(false);
  });
});
