import { describe, expect, test } from "bun:test";
import {
  validateEntityValue,
  validatePluginManifest,
  validateStationCapabilities,
  validateStationJobCompletion,
  validateStationJobRequest,
  validateStationStepUpdate,
  validateStationWorkflow,
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

describe("station workflow contracts", () => {
  const workflow = {
    id: "flash.verify",
    version: 1,
    requiredCapabilities: ["esp32.flash"],
    inputSchema: {
      firmware_id: { type: "string" as const, required: true },
    },
    steps: [
      {
        id: "detect",
        executor: "esp32.detect",
        timeoutSeconds: 10,
        maxAttempts: 2,
        irreversible: false,
        recoveryPolicy: "retry" as const,
      },
      {
        id: "flash",
        executor: "esp32.flash",
        timeoutSeconds: 60,
        maxAttempts: 1,
        irreversible: true,
        recoveryPolicy: "quarantine" as const,
      },
    ],
    maxDurationSeconds: 120,
  };

  test("accepts versioned workflow and rejects duplicate steps", () => {
    expect(validateStationWorkflow(workflow).ok).toBe(true);
    expect(
      validateStationWorkflow({
        ...workflow,
        steps: [workflow.steps[0], { ...workflow.steps[0] }],
      }).ok,
    ).toBe(false);
    expect(
      validateStationWorkflow({
        ...workflow,
        inputSchema: { value: { type: "string", min: 1 } },
      }).ok,
    ).toBe(false);
    expect(
      validateStationWorkflow({
        ...workflow,
        steps: [{
          ...workflow.steps[0],
          resources: [
            { type: "jtag", id: "probe-1", exclusive: true },
            { type: "jtag", id: "probe-1", exclusive: true },
          ],
        }, workflow.steps[1]],
      }).ok,
    ).toBe(false);
  });

  test("accepts HTTPS full agents and rejects process isolation on embedded stations", () => {
    expect(
      validateStationCapabilities({
        protocolVersion: 1,
        agentClass: "full",
        platform: "linux",
        transports: ["https"],
        executors: ["esp32.flash"],
        maxArtifactBytes: 1024,
        maxEventBytes: 1024,
        maxConcurrentJobs: 1,
        supportsHttpRange: true,
        supportsProcessIsolation: true,
      }).ok,
    ).toBe(true);
    expect(
      validateStationCapabilities({
        protocolVersion: 1,
        agentClass: "embedded",
        platform: "mcu",
        transports: ["mqtt-wss"],
        executors: [],
        maxArtifactBytes: 1024,
        maxEventBytes: 1024,
        maxConcurrentJobs: 1,
        supportsHttpRange: false,
        supportsProcessIsolation: true,
      }).ok,
    ).toBe(false);
  });

  test("bounds and types a station job request", () => {
    expect(
      validateStationJobRequest({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        input: { firmware_id: "artifact-1" },
        idempotencyKey: "job-key-1",
        artifacts: [],
      }).ok,
    ).toBe(true);
    expect(
      validateStationJobRequest({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        input: { firmware_id: "artifact-1" },
        idempotencyKey: "",
      }).ok,
    ).toBe(false);
  });

  test("fences station progress and completion with an attempt generation", () => {
    const jobId = crypto.randomUUID();
    const lease = { attemptId: "attempt-1", generation: 3 };
    expect(validateStationStepUpdate({
      jobId,
      lease,
      sequence: 1,
      stepId: "flash",
      state: "succeeded",
      occurredAt: new Date().toISOString(),
    }).ok).toBe(true);
    expect(validateStationJobCompletion({
      jobId,
      lease,
      finalSequence: 1,
      status: "succeeded",
    }).ok).toBe(true);
    expect(validateStationStepUpdate({
      jobId,
      lease: { ...lease, generation: -1 },
      sequence: 2,
      stepId: "flash",
      state: "failed",
      occurredAt: new Date().toISOString(),
    }).ok).toBe(false);
  });
});
