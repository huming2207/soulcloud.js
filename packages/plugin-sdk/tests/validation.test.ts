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
      { entityKey: "temperature", value: 20, sequence: 1n << 64n },
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

  test("requires a lowercase SHA-256 digest for each client asset", () => {
    const base = { id: "example.plugin", version: "1", apiVersion: 1 as const, profiles: [], actions: [], events: [] };
    expect(() => validateManifest({ ...base, ui: { routes: [], assets: [{ path: "/app.js", contentType: "text/javascript" }] } })).toThrow();
    expect(() => validateManifest({ ...base, ui: { routes: [], assets: [{ path: "/app.js", contentType: "text/javascript", sha256: "A".repeat(64) }] } })).toThrow("asset sha256");
    expect(() => validateManifest({ ...base, ui: { routes: [], assets: [{ path: "/app.js", contentType: "text/javascript", sha256: "a".repeat(64) }] } })).not.toThrow();
  });

  test("coerces typed form/query values before validation", () => {
    const schema = { count: { type: "integer" as const, required: true }, enabled: { type: "boolean" as const, required: true } };
    const value = coerceStringActionInput(schema, { count: "3", enabled: "true" });
    expect(value).toEqual({ count: 3, enabled: true });
    expect(validateActionInput(schema, value)).toEqual({ ok: true });
  });
});

describe("plugin manifest descriptor validation", () => {
  const base = { id: "example.plugin", version: "1", apiVersion: 1 as const, actions: [], events: [] };

  test("requires a non-empty unique value set only for enum Entities", () => {
    const profile = {
      id: "fixture",
      version: 1,
      manufacturer: "Soulcloud",
      model: "Fixture",
      capabilities: [],
      entities: [{ key: "mode", valueType: "enum", category: "primary" }],
    };
    expect(() => validateManifest({ ...base, profiles: [profile] })).toThrow("requires enumValues");
    expect(() => validateManifest({
      ...base,
      profiles: [{ ...profile, entities: [{ ...profile.entities[0], enumValues: ["run", "run"] }] }],
    })).toThrow("duplicate enum value");
    expect(() => validateManifest({
      ...base,
      profiles: [{ ...profile, entities: [{ key: "name", valueType: "string", category: "primary", enumValues: ["x"] }] }],
    })).toThrow("non-enum entity");
  });

  test("rejects contradictory Action field constraints and defaults", () => {
    const manifest = (field: Record<string, unknown>) => ({
      ...base,
      profiles: [],
      actions: [{ id: "run", inputSchema: { value: field }, wire: { command: "run", schemaVersion: 1 } }],
    });
    expect(() => validateManifest(manifest({ type: "string", min: 1 }))).toThrow("min/max for numeric types");
    expect(() => validateManifest(manifest({ type: "number", min: 2, max: 1 }))).toThrow("min cannot exceed max");
    expect(() => validateManifest(manifest({ type: "boolean", enum: ["true"] }))).toThrow("enum for string fields");
    expect(() => validateManifest(manifest({ type: "integer", default: 1.5 }))).toThrow("invalid default");
    expect(() => validateManifest(manifest({ type: "number", maxLength: 4 }))).toThrow("maxLength for string");
    const stringManifest = manifest({ type: "string", maxLength: 4 });
    const stringSchema = (stringManifest.actions[0] as { inputSchema: Record<string, unknown> }).inputSchema;
    expect(validateActionInput(stringSchema as never, { value: "12345" })).toMatchObject({ ok: false });
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
