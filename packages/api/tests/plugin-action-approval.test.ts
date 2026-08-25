import { describe, expect, test } from "bun:test";
import { pluginActionRequestBody } from "../src/api/plugin-manager";

const deviceId = "00000000-0000-4000-8000-000000000001";

describe("plugin action approval request", () => {
  test("defaults approval to false so destructive actions cannot be implicitly approved", () => {
    expect(pluginActionRequestBody.parse({ device_id: deviceId, input: {} })).toEqual({
      device_id: deviceId,
      input: {},
      human_approved: false,
    });
  });

  test("preserves explicit human approval", () => {
    expect(pluginActionRequestBody.parse({ device_id: deviceId, input: {}, human_approved: true }).human_approved).toBe(true);
  });

  test("rejects unknown approval fields", () => {
    expect(() => pluginActionRequestBody.parse({ device_id: deviceId, input: {}, approved: true })).toThrow();
  });
});
