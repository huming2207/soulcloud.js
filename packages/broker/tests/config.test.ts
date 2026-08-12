/**
 * Broker environment configuration tests: valid parse with defaults, and
 * the fail-fast path (missing JWT_SECRET must exit, never start with a
 * default secret).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loadBrokerConfig } from "../src/config";

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of ["JWT_SECRET", "MQTT_BROKER_PORT", "MQTT_COMMAND_RETAIN", "UPLINK_MAX_PACKET_BYTES"]) {
    if (!(k in saved)) delete process.env[k];
  }
});

describe("loadBrokerConfig", () => {
  test("parses a valid environment with defaults", () => {
    process.env.JWT_SECRET = "x".repeat(32);
    const config = loadBrokerConfig();
    expect(config.MQTT_BROKER_PORT).toBe(1883);
    expect(config.MQTT_BROKER_PATH).toBe("/mqtt");
    expect(config.MQTT_COMMAND_RETAIN).toBe(false);
    expect(config.OTA_STALL_TIMEOUT_MINUTES).toBe(30);
    expect(config.UPLINK_RATE_PER_SECOND).toBe(20);
    expect(config.UPLINK_WORK_CONCURRENCY).toBe(16);
    expect(config.UPLINK_WORK_CAPACITY).toBe(1024);
  });

  test("coerces and honours explicit values", () => {
    process.env.JWT_SECRET = "y".repeat(32);
    process.env.MQTT_BROKER_PORT = "1884";
    process.env.MQTT_COMMAND_RETAIN = "true";
    process.env.UPLINK_MAX_PACKET_BYTES = "1024";
    const config = loadBrokerConfig();
    expect(config.MQTT_BROKER_PORT).toBe(1884);
    expect(config.MQTT_COMMAND_RETAIN).toBe(true);
    expect(config.UPLINK_MAX_PACKET_BYTES).toBe(1024);
  });

  test("exits with a readable listing when JWT_SECRET is missing", () => {
    delete process.env.JWT_SECRET;
    const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      loadBrokerConfig();
      expect(exit).toHaveBeenCalledWith(1);
      const messages = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("JWT_SECRET");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  test("defaults BROKER_AUTH_CONCURRENCY to 8", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    const config = loadBrokerConfig();
    expect(config.BROKER_AUTH_CONCURRENCY).toBe(8);
  });

  test("honours an explicit BROKER_AUTH_CONCURRENCY", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    process.env.BROKER_AUTH_CONCURRENCY = "2";
    const config = loadBrokerConfig();
    expect(config.BROKER_AUTH_CONCURRENCY).toBe(2);
  });

  test("rejects uplink capacity below concurrency", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    process.env.UPLINK_WORK_CONCURRENCY = "8";
    process.env.UPLINK_WORK_CAPACITY = "4";
    expect(() => loadBrokerConfig()).toThrow(/UPLINK_WORK_CAPACITY/);
    delete process.env.UPLINK_WORK_CONCURRENCY;
    delete process.env.UPLINK_WORK_CAPACITY;
  });

  test("refuses MQTT_COMMAND_RETAIN in production (WEB-12)", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    process.env.MQTT_COMMAND_RETAIN = "true";
    process.env.NODE_ENV = "production";
    expect(() => loadBrokerConfig()).toThrow(/MQTT_COMMAND_RETAIN/);
    delete process.env.NODE_ENV;
  });

  test("allows MQTT_COMMAND_RETAIN outside production", () => {
    process.env.JWT_SECRET = "z".repeat(32);
    process.env.MQTT_COMMAND_RETAIN = "true";
    const config = loadBrokerConfig();
    expect(config.MQTT_COMMAND_RETAIN).toBe(true);
  });
});
