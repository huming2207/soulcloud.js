/**
 * Config wiring tests: the API process must receive its JWT configuration
 * from the environment (C1 audit fix) — no hardcoded secrets may survive
 * the config -> createApp path, and JWT_SECRET must fail fast when absent.
 */

import { describe, expect, test } from "bun:test";
import { envSchema } from "../../src/config";

describe("API env config (C1)", () => {
  test("JWT_SECRET is required — no default, fail-fast", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues).toContain("JWT_SECRET");
    }
  });

  test("a short JWT_SECRET is rejected (< 32 chars)", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud",
      JWT_SECRET: "too-short",
    });
    expect(result.success).toBe(false);
  });

  test("a strong JWT_SECRET parses with the default TTLs", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud",
      JWT_SECRET: "x".repeat(32),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.JWT_ACCESS_TTL_SECONDS).toBe(15 * 60);
      expect(result.data.JWT_REFRESH_TTL_SECONDS).toBe(30 * 24 * 3600);
      expect(result.data.OTA_TARGET_TTL_SECONDS).toBe(15 * 60);
      expect(result.data.AUTH_ARGON2_CONCURRENCY).toBe(4);
    }
  });

  test("OTA timeout settings are configurable via env", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud",
      JWT_SECRET: "x".repeat(32),
      OTA_TARGET_TTL_SECONDS: "600",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.OTA_TARGET_TTL_SECONDS).toBe(600);
  });
});

describe("createApp JWT wiring (C1 round-5)", () => {
  test("createApp without a JwtConfig throws at runtime (no hardcoded fallback)", async () => {
    const { createApp } = await import("../../src/api/app");
    // a JS caller passing undefined must fail loudly, never degrade to a
    // public dev secret
    expect(() =>
      createApp(undefined as never, undefined as never),
    ).toThrow(/JwtConfig/);
  });
});
