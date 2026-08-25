import { describe, expect, test } from "bun:test";
import { CommandQueueError, validateCommandProvenance } from "../../src";

describe("device command provenance", () => {
  test("accepts plugin provenance without changing the wire command contract", () => {
    expect(() => validateCommandProvenance({
      originType: "plugin",
      originUserId: "00000000-0000-4000-8000-000000000001",
      pluginInstallationId: "00000000-0000-4000-8000-000000000002",
      pluginVersion: "0.1.0",
      manifestHash: "a".repeat(64),
      executionId: "00000000-0000-4000-8000-000000000003",
      correlationId: "00000000-0000-4000-8000-000000000004",
      idempotencyKey: "operation-1",
    })).not.toThrow();
  });

  test("rejects malformed audit identifiers", () => {
    const validPluginProvenance = {
      originType: "plugin" as const,
      pluginInstallationId: "00000000-0000-4000-8000-000000000002",
      pluginVersion: "0.1.0",
      manifestHash: "a".repeat(64),
    };
    expect(() => validateCommandProvenance({ originType: "plugin" })).toThrow("require plugin installation");
    expect(() => validateCommandProvenance({ ...validPluginProvenance, correlationId: "not-a-uuid" })).toThrow(CommandQueueError);
    expect(() => validateCommandProvenance({ ...validPluginProvenance, manifestHash: "bad" })).toThrow("SHA-256");
    expect(() => validateCommandProvenance({ ...validPluginProvenance, idempotencyKey: "" })).toThrow("idempotencyKey");
  });

  test("allows legacy callers to omit provenance and defaults them to human", () => {
    expect(() => validateCommandProvenance(undefined)).not.toThrow();
  });
});
