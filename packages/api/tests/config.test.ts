/**
 * API environment configuration tests: loadApiConfig parses the shared
 * schema plus API-specific fields, and fails fast without JWT_SECRET.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loadApiConfig, parseBindAddress } from "../src/config";

const SAVED = [
  "JWT_SECRET",
  "API_BIND_ADDRESS",
  "OTA_TARGET_TTL_SECONDS",
  "ROLLOUT_POLL_INTERVAL_MS",
  "AUTH_ARGON2_CONCURRENCY",
  "AUTH_LOGIN_FAILURE_CAPACITY",
];

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
    expect(config.AUTH_ARGON2_CONCURRENCY).toBe(4);
    expect(config.AUTH_LOGIN_FAILURE_CAPACITY).toBe(10_000);
  });

  test("honours explicit values", () => {
    process.env.JWT_SECRET = "a".repeat(32);
    process.env.API_BIND_ADDRESS = "127.0.0.1:9999";
    process.env.OTA_TARGET_TTL_SECONDS = "60";
    process.env.AUTH_ARGON2_CONCURRENCY = "2";
    const config = loadApiConfig();
    expect(config.API_BIND_ADDRESS).toBe("127.0.0.1:9999");
    expect(config.OTA_TARGET_TTL_SECONDS).toBe(60);
    expect(config.AUTH_ARGON2_CONCURRENCY).toBe(2);
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

describe("parseBindAddress", () => {
  test("parses host:port", () => {
    expect(parseBindAddress("127.0.0.1:8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
  });

  test("parses [::1]:port (IPv6 loopback)", () => {
    expect(parseBindAddress("[::1]:8080")).toEqual({ hostname: "::1", port: 8080 });
  });

  test("parses [::]:port (unspecified IPv6)", () => {
    expect(parseBindAddress("[::]:8080")).toEqual({ hostname: "::", port: 8080 });
  });

  test("parses multi-segment IPv6 addresses", () => {
    expect(parseBindAddress("[2001:db8::1]:9000")).toEqual({ hostname: "2001:db8::1", port: 9000 });
    expect(parseBindAddress("[fe80::1:2:3:4]:443")).toEqual({ hostname: "fe80::1:2:3:4", port: 443 });
  });

  test("accepts the port boundaries 1 and 65535", () => {
    expect(parseBindAddress("0.0.0.0:1")).toEqual({ hostname: "0.0.0.0", port: 1 });
    expect(parseBindAddress("0.0.0.0:65535")).toEqual({ hostname: "0.0.0.0", port: 65535 });
  });

  test("rejects addresses without a port", () => {
    expect(parseBindAddress("[::1]")).toBeNull();
    expect(parseBindAddress("127.0.0.1:")).toBeNull();
  });

  test("rejects out-of-range or non-numeric ports", () => {
    expect(parseBindAddress("127.0.0.1:0")).toBeNull();
    expect(parseBindAddress("127.0.0.1:65536")).toBeNull();
    expect(parseBindAddress("127.0.0.1:abc")).toBeNull();
    expect(parseBindAddress("127.0.0.1:80x")).toBeNull();
  });

  test("rejects empty, trailing-whitespace, and malformed addresses", () => {
    expect(parseBindAddress("")).toBeNull();
    expect(parseBindAddress("127.0.0.1:8080 ")).toBeNull();
    expect(parseBindAddress("[::1]:8080 ")).toBeNull();
    expect(parseBindAddress("not-an-address")).toBeNull();
    expect(parseBindAddress("host:port:extra")).toBeNull();
    expect(parseBindAddress(":8080")).toBeNull();
  });

  test("preserves the old regex behavior for whitespace inside the host part", () => {
    // `[^:]+` matches spaces, so a leading space is part of the hostname —
    // same as the inline regex previously used by index.ts.
    expect(parseBindAddress(" 127.0.0.1:8080")).toEqual({ hostname: " 127.0.0.1", port: 8080 });
  });

  test("returns null for null/undefined input", () => {
    expect(parseBindAddress(null as unknown as string)).toBeNull();
    expect(parseBindAddress(undefined as unknown as string)).toBeNull();
  });
});
