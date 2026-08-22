import { expect, test } from "bun:test";
import { parsePluginHostUrls } from "../src/config";

test("orpc-ws normalizes an HTTP host endpoint to the WebSocket path", () => {
  expect(parsePluginHostUrls("example=http://host:8090", "orpc-ws").get("example"))
    .toBe("ws://host:8090/rpc/ws");
});

test("http-msgpack rejects a WebSocket endpoint instead of silently switching transports", () => {
  expect(() => parsePluginHostUrls("example=ws://host:8090/rpc/ws", "http-msgpack"))
    .toThrow("must use http(s)");
});
