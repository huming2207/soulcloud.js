import { describe, expect, test } from "bun:test";
import { coerceStringActionInput, validateActionInput, validateEntityUpdates, validateManifest } from "../src/validation";

describe("validateEntityUpdates", () => {
  test("rejects duplicate updates before they reach the database batch", () => {
    expect(() => validateEntityUpdates(
      [{ key: "temperature", valueType: "number", category: "measurement" }],
      [
        { entityKey: "temperature", value: 20 },
        { entityKey: "temperature", value: 21 },
      ],
    )).toThrow("duplicate entity update temperature");
  });
});

describe("plugin UI manifest validation", () => {
  test("requires schemas for POST routes and unique route paths", () => {
    const base = { id: "example.plugin", version: "1", apiVersion: 1 as const, profiles: [], actions: [], events: [] };
    expect(() => validateManifest({ ...base, ui: { routes: [{ id: "edit", path: "/edit", methods: ["POST"] }] } })).toThrow("POST routes require actionSchema");
    expect(() => validateManifest({ ...base, ui: { routes: [{ id: "one", path: "/same" }, { id: "two", path: "/same" }] } })).toThrow("duplicate UI route path");
  });

  test("coerces typed form/query values before validation", () => {
    const schema = { count: { type: "integer" as const, required: true }, enabled: { type: "boolean" as const, required: true } };
    const value = coerceStringActionInput(schema, { count: "3", enabled: "true" });
    expect(value).toEqual({ count: 3, enabled: true });
    expect(validateActionInput(schema, value)).toEqual({ ok: true });
  });
});
