/**
 * API environment configuration tests: loadApiConfig parses the shared
 * schema plus API-specific fields, and fails fast without JWT_SECRET.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loadApiConfig } from "../src/config";

const SAVED = ["JWT_SECRET", "API_BIND_ADDRESS", "OTA_TARGET_TTL_SECONDS", "ROLLOUT_POLL_INTERVAL_MS"];

afterEach(() => {
  for (const k of SAVED) delete process.env[k];
});

describe("loadApiConfig", () => {
  test("parses a valid environment with defaults", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    const config = loadApiConfig();
    expect(config.API_BIND_ADDRESS).toBe("0.0.0.0:8080");
    expect(config.OTA_TARGET_TTL_SECONDS).toBe(15 * 60);
    expect(config.ROLLOUT_POLL_INTERVAL_MS).toBe(30_000);
    expect(config.JWT_ACCESS_TTL_SECONDS).toBe(15 * 60);
  });

  test("honours explicit values", () => {
    process.env.JWT_SECRET = "a".repeat(32);
    process.env.API_BIND_ADDRESS = "127.0.0.1:9999";
    process.env.OTA_TARGET_TTL_SECONDS = "60";
    const config = loadApiConfig();
    expect(config.API_BIND_ADDRESS).toBe("127.0.0.1:9999");
    expect(config.OTA_TARGET_TTL_SECONDS).toBe(60);
  });

  test("exits with a readable listing when JWT_SECRET is missing", () => {
    delete process.env.JWT_SECRET;
    const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      loadApiConfig();
      expect(exit).toHaveBeenCalledWith(1);
      const messages = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("JWT_SECRET");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
