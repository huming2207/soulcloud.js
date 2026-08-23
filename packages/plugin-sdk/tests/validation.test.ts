import { describe, expect, test } from "bun:test";
import { coerceStringActionInput, validateActionInput, validateEntityUpdates, validateManifest } from "../src/validation";
import { definePlugin } from "../src/define";

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

  test("rejects sequence and timestamp errors before RPC output", () => {
    const descriptors = [{ key: "temperature", valueType: "number" as const, category: "measurement" as const }];
    expect(() => validateEntityUpdates(descriptors, [
      { entityKey: "temperature", value: 20, sequence: -1n },
    ])).toThrow("invalid sequence");
    expect(() => validateEntityUpdates(descriptors, [
      { entityKey: "temperature", value: 20, sourceTimestamp: "not-a-date" },
    ])).toThrow("invalid source timestamp");
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

describe("plugin implementation validation", () => {
  test("fails startup when a declared operation has no implementation", () => {
    const base = { id: "example.plugin", version: "1", apiVersion: 1 as const, profiles: [], actions: [], events: [] };
    expect(() => definePlugin({
      manifest: {
        ...base,
        actions: [{ id: "run", inputSchema: {}, wire: { command: "run", schemaVersion: 1 } }],
      },
    })).toThrow("plugin action run has no encoder");
    expect(() => definePlugin({
      manifest: { ...base, events: [{ kind: "result", schemaVersion: 1 }] },
    })).toThrow("plugin declares events but has no event handler");
    expect(() => definePlugin({
      manifest: {
        ...base,
        ui: { routes: [{ id: "main", path: "/main", methods: ["GET", "POST"], actionSchema: {} }] },
      },
      render: { main: async () => ({ html: "ok" }) },
    })).toThrow("plugin UI route main accepts POST but has no action handler");
  });

  test("rejects implementations not declared by the manifest", () => {
    const manifest = { id: "example.plugin", version: "1", apiVersion: 1 as const, profiles: [], actions: [], events: [] };
    expect(() => definePlugin({ manifest, encodeAction: { ghost: () => [] } })).toThrow(
      "plugin encoder ghost is not declared in the manifest",
    );
  });
});
