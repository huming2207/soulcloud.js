import { describe, expect, test } from "bun:test";
import { pluginManagerOperationTimeoutMs } from "../src/api/plugin-manager";

describe("Plugin Manager operation deadline", () => {
  test("finishes before the Human API internal request deadline", () => {
    expect(pluginManagerOperationTimeoutMs()).toBe(4_000);
    expect(pluginManagerOperationTimeoutMs(500)).toBe(100);
    expect(pluginManagerOperationTimeoutMs(60_000)).toBe(30_000);
  });
});
