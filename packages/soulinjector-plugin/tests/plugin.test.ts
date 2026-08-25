import { describe, expect, test } from "bun:test";
import { createSoulInjectorPlugin } from "../src/plugin";
import { definePlugin } from "@soulcloud/plugin-sdk";

const saved = {
  id: "00000000-0000-4000-8000-000000000001",
  installationId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  revision: 1,
  yaml: "version: 1\ntargets:\n  - id: fixture\n    displayName: Fixture\n    architecture: cortex-m\n    chip: fixture\n    transport: swd\n    requiredPrimitives: [identify]",
  config: { version: 1 as const, targets: [{ id: "fixture", displayName: "Fixture", architecture: "cortex-m", chip: "fixture", transport: "swd" as const, requiredPrimitives: ["identify" as const] }] },
  sha256: "a".repeat(64),
  createdBy: "00000000-0000-4000-8000-000000000004",
  createdAt: new Date(0).toISOString(),
};

function store() {
  return {
    saveTargetConfig: async () => saved,
    getLatestTargetConfig: async () => saved,
    getTargetConfig: async () => saved,
    listTargetConfigs: async () => [{ configId: saved.id, revision: saved.revision, sha256: saved.sha256, targetCount: saved.config.targets.length, createdAt: saved.createdAt }],
    listArtifacts: async () => [{ id: saved.id, installationId: saved.installationId, projectId: saved.projectId, kind: "elf" as const, filename: "fixture.elf", contentType: "application/octet-stream", size: 4, sha256: saved.sha256, createdBy: saved.createdBy, createdAt: saved.createdAt }],
    storeArtifactChunk: async (input: { uploadId: string; offset: number; chunk: Uint8Array; final: boolean }) => ({ uploadId: input.uploadId, receivedBytes: input.offset + input.chunk.byteLength, complete: input.final, artifactId: input.final ? saved.id : null, sha256: input.final ? saved.sha256 : null }),
  };
}

describe("SoulInjector plugin", () => {
  test("declares debugger actions with human approval on destructive operations", () => {
    const plugin = createSoulInjectorPlugin(store());
    const validated = definePlugin(plugin);
    expect(validated.manifest.actions.find((action) => action.id === "debug.reset")?.requiresHumanApproval).toBe(true);
    expect(validated.manifest.actions.find((action) => action.id === "debug.read_memory")?.requiresHumanApproval).not.toBe(true);
  });

  test("encodes bounded high-level device commands", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const args = await plugin.encodeAction!["debug.read_memory"]!({ targetConfigRevision: 3, targetId: "fixture", address: 4096, length: 32 }, { operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, deviceId: saved.installationId, userId: saved.createdBy });
    expect(args).toEqual([{ targetConfigRevision: 3 }, { targetId: "fixture" }, { architecture: "cortex-m" }, { chip: "fixture" }, { transport: "swd" }, { requiredPrimitives: "identify" }, { address: 4096 }, { length: 32 }]);
  });

  test("does not encode a target from another project or missing revision", async () => {
    const plugin = createSoulInjectorPlugin({
      ...store(),
      getTargetConfig: async () => ({ ...saved, projectId: "00000000-0000-4000-8000-000000000099" }),
    });
    await expect(plugin.encodeAction!["debug.identify"]!({ targetConfigRevision: 3, targetId: "fixture" }, {
      operationId: "operation",
      installationId: saved.installationId,
      projectId: saved.projectId,
      deviceId: saved.installationId,
      userId: saved.createdBy,
    })).rejects.toThrow("target configuration revision or target id is not available");
  });

  test("stores target config through both RPC and SSR action paths", async () => {
    const calls: string[] = [];
    const repository = {
      saveTargetConfig: async (input: { createdBy: string }) => { calls.push(input.createdBy); return saved; },
      getLatestTargetConfig: async () => saved,
      getTargetConfig: async () => saved,
      storeArtifactChunk: async (input: { uploadId: string; offset: number; chunk: Uint8Array; final: boolean }) => ({ uploadId: input.uploadId, receivedBytes: input.offset + input.chunk.byteLength, complete: input.final, artifactId: input.final ? saved.id : null, sha256: input.final ? saved.sha256 : null }),
    };
    const plugin = createSoulInjectorPlugin(repository);
    const configured = await plugin.configureTarget!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy, yaml: saved.yaml }, { signal: AbortSignal.timeout(1000) });
    expect(configured).toMatchObject({ configId: saved.id, revision: 1, targetCount: 1 });
    const result = await plugin.handleAction!["debugger"]!({ intent: "save_target", yaml: saved.yaml }, { requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: {} });
    expect(result).toEqual({ redirect: `/plugins/${saved.installationId}/debugger` });
    expect(calls).toEqual([saved.createdBy, saved.createdBy]);
  });

  test("creates a private debugger case through the SSR action path", async () => {
    const created: unknown[] = [];
    const plugin = createSoulInjectorPlugin({
      ...store(),
      createDebugCase: async (input) => {
        created.push(input);
        return {
          id: saved.id,
          projectId: saved.projectId,
          targetUnitRef: input.targetUnitRef ?? null,
          state: "open",
          title: input.title,
          createdBy: input.createdBy,
          assignedTo: null,
          createdAt: saved.createdAt,
          updatedAt: saved.createdAt,
        };
      },
    });
    const result = await plugin.handleAction!["debugger"]!({ intent: "create_case", title: "Overheating probe", targetUnitRef: "unit-42" }, { requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: {} });
    expect(result).toEqual({ redirect: `/plugins/${saved.installationId}/debugger` });
    expect(created).toEqual([{ projectId: saved.projectId, targetUnitRef: "unit-42", title: "Overheating probe", createdBy: saved.createdBy }]);
  });

  test("renders private debugger session summaries without exposing execution credentials", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const plugin = createSoulInjectorPlugin({
      ...store(),
      listDebugSessions: async () => [{
        id: sessionId,
        caseId: saved.id,
        soulcloudDeviceRef: "soulinjector-device-1",
        executionRef: "00000000-0000-4000-8000-000000000007",
        state: "active",
        pluginVersion: "0.1.0",
        manifestHash: saved.sha256,
        deviceFirmwareVersion: null,
        startedBy: saved.createdBy,
        controller: saved.createdBy,
        startedAt: saved.createdAt,
        endedAt: null,
      }],
    });
    const result = await plugin.render!["debugger"]!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      params: {},
    });
    expect(result.html).toContain(sessionId);
    expect(result.html).toContain("soulinjector-device-1");
    expect(result.html).not.toContain("executionToken");
  });

  test("persists device observations idempotently by broker event id", async () => {
    const observations: unknown[] = [];
    const plugin = createSoulInjectorPlugin({
      ...store(),
      appendDebugObservation: async (input) => { observations.push(input); },
    });
    const sessionId = "00000000-0000-4000-8000-000000000005";
    const result = await plugin.onEvent!({
      operationId: "operation",
      signal: AbortSignal.timeout(1000),
      installation: { id: saved.installationId, projectId: saved.projectId, pluginId: "debugger", pluginVersion: "1.0.0", config: null },
      device: { id: saved.installationId, uid: "soulinjector-1", profileId: "debug", profileVersion: 1 },
      execution: null,
      getEntity: async () => null,
      enqueueCommand: async () => undefined,
      callPlugin: async () => undefined,
      devices: null,
    }, {
      id: "broker-event-1",
      seq: 1n,
      kind: "debug.status",
      schema: 1,
      receivedAt: new Date(0).toISOString(),
      payload: { state: "running", sessionId },
      installation: { id: saved.installationId, projectId: saved.projectId, pluginId: "debugger", pluginVersion: "1.0.0", config: null },
      device: { id: saved.installationId, uid: "soulinjector-1", profileId: "debug", profileVersion: 1 },
    });
    expect(result.updates).toEqual([{ entityKey: "debug.state", value: "running" }, { entityKey: "debug.session_id", value: sessionId }]);
    expect(observations).toEqual([{ projectId: saved.projectId, sessionId, soulcloudDeviceRef: saved.installationId, eventRef: "broker-event-1", source: "device", kind: "debug.status", structuredData: { state: "running", sessionId } }]);
  });

  test("lists target configuration revision metadata without exposing YAML", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const result = await plugin.listTargetConfigs!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy }, { signal: AbortSignal.timeout(1000) });
    expect(result).toEqual([{ configId: saved.id, revision: 1, sha256: saved.sha256, targetCount: 1, createdAt: saved.createdAt }]);
    expect(result[0]).not.toHaveProperty("yaml");
  });

  test("lists artifact metadata without exposing artifact bytes", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const result = await plugin.listArtifacts!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy }, { signal: AbortSignal.timeout(1000) });
    expect(result).toEqual([{ artifactId: saved.id, kind: "elf", filename: "fixture.elf", contentType: "application/octet-stream", size: 4, sha256: saved.sha256, createdAt: saved.createdAt }]);
    expect(result[0]).not.toHaveProperty("content");
  });

  test("passes artifact chunks to the private store", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const result = await plugin.storeArtifactChunk!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy, uploadId: saved.id, kind: "firmware", filename: "image.bin", contentType: "application/octet-stream", totalSize: 3, offset: 0, final: true, chunk: Uint8Array.of(1, 2, 3) }, { signal: AbortSignal.timeout(1000) });
    expect(result).toMatchObject({ uploadId: saved.id, receivedBytes: 3, complete: true, artifactId: saved.id });
  });
});
