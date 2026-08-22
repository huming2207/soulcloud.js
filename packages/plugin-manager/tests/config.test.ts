import { describe, expect, test } from "bun:test";
import { parsePluginEndpoints } from "../src/config";

describe("PLUGIN_ENDPOINTS", () => {
  test("normalizes a root path to the RPC endpoint", () => {
    expect(parsePluginEndpoints("example.plugin=ws://plugin:8090").get("example.plugin")).toBe("ws://plugin:8090/rpc/ws");
  });

  test("rejects duplicate IDs and non-WebSocket URLs", () => {
    expect(() => parsePluginEndpoints("x=ws://a:1,x=ws://b:2")).toThrow();
    expect(() => parsePluginEndpoints("x=http://a:1")).toThrow();
  });
});
