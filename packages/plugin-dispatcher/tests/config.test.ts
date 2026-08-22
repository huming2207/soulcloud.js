import { expect, test } from "bun:test";
import { parsePluginHostEndpoints } from "../src/config";

test("requires a WebSocket host endpoint and normalizes the path", () => {
  expect(parsePluginHostEndpoints("example=ws://host:8090").get("example"))
    .toBe("ws://host:8090/rpc/ws");
});

test("rejects HTTP and non-RPC WebSocket endpoints", () => {
  expect(() => parsePluginHostEndpoints("example=http://host:8090"))
    .toThrow("must use ws(s)");
  expect(() => parsePluginHostEndpoints("example=ws://host:8090/other"))
    .toThrow("must end in /rpc/ws");
});
