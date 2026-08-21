import { describe, expect, test } from "bun:test";
import {
  validateEntityValue,
  validatePluginManifest,
  type EntityDescriptor,
} from "../src/index";

const numberEntity: EntityDescriptor = {
  key: "test.voltage",
  valueType: "number",
  access: "read",
  category: "measurement",
  unit: "V",
  history: "all",
};

describe("validatePluginManifest", () => {
  const base = {
    id: "acme.test",
    version: "1.0.0",
    apiVersion: 1,
    profiles: [
      {
        id: "fixture_v1",
        version: 1,
        manufacturer: "Acme",
        model: "Fixture",
        capabilities: ["flash"],
        entities: [numberEntity],
      },
    ],
    actions: [],
    events: [{ kind: "ok", schemaVersion: 1 }],
    workflows: [],
    ui: {},
  };

  test("accepts a valid manifest", () => {
    const result = validatePluginManifest(base);
    expect(result.ok).toBe(true);
  });

  test("rejects an invalid plugin id", () => {
    const result = validatePluginManifest({ ...base, id: "Not Valid!" });
    expect(result.ok).toBe(false);
  });

  test("rejects enum entities without values", () => {
    const result = validatePluginManifest({
      ...base,
      profiles: [
        {
          ...base.profiles[0]!,
          entities: [
            { ...numberEntity, key: "test.mode", valueType: "enum" as const },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects sampled history without an interval", () => {
    const result = validatePluginManifest({
      ...base,
      profiles: [
        {
          ...base.profiles[0]!,
          entities: [
            { ...numberEntity, history: "sampled" as const },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate profile ids", () => {
    const result = validatePluginManifest({
      ...base,
      profiles: [base.profiles[0]!, base.profiles[0]!],
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateEntityValue", () => {
  test("number", () => {
    expect(validateEntityValue(numberEntity, 3.3).ok).toBe(true);
    expect(validateEntityValue(numberEntity, "3.3").ok).toBe(false);
    expect(validateEntityValue(numberEntity, Number.NaN).ok).toBe(false);
    expect(validateEntityValue(numberEntity, Infinity).ok).toBe(false);
  });

  test("null/undefined values are legal (state-only updates)", () => {
    expect(validateEntityValue(numberEntity, null).ok).toBe(true);
    expect(validateEntityValue(numberEntity, undefined).ok).toBe(true);
  });

  test("enum membership", () => {
    const descriptor: EntityDescriptor = {
      key: "test.mode",
      valueType: "enum",
      access: "read",
      category: "diagnostic",
      enumValues: ["standby", "running"],
      history: "changes",
    };
    expect(validateEntityValue(descriptor, "running").ok).toBe(true);
    expect(validateEntityValue(descriptor, "fault").ok).toBe(false);
    expect(validateEntityValue(descriptor, 3).ok).toBe(false);
  });

  test("binary must be base64 and bounded", () => {
    const descriptor: EntityDescriptor = {
      key: "test.blob",
      valueType: "binary",
      access: "read",
      category: "diagnostic",
      history: "none",
    };
    expect(validateEntityValue(descriptor, "aGVsbG8=").ok).toBe(true);
    expect(validateEntityValue(descriptor, "not base64!!").ok).toBe(false);
    expect(
      validateEntityValue(descriptor, "A".repeat(200_000)).ok,
    ).toBe(false);
  });
});

describe("JSON-RPC message contract", () => {
  test("uses ordinary JSON request and response objects", () => {
    const request = { id: 1, method: "m", params: { value: 1 }, deadlineMs: 10 };
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});
