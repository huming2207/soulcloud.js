import { describe, expect, test } from "bun:test";
import { createSoulInjectorPlugin } from "../src/plugin";
import { DebugSessionNotAvailableError } from "../src/repository";
import { TargetConfigError } from "../src/target-config";
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
    listArtifacts: async () => [{ id: saved.id, installationId: saved.installationId, projectId: saved.projectId, kind: "elf" as const, filename: "fixture.elf", contentType: "application/octet-stream", size: 4, sha256: saved.sha256, metadata: { format: "elf", elfClass: "ELF64", machine: 243 }, createdBy: saved.createdBy, createdAt: saved.createdAt }],
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
    expect(plugin.manifest.actions.find((action) => action.id === "debug.read_memory")?.inputSchema).toMatchObject({
      architecture: { type: "string" },
      chip: { type: "string" },
      transport: { type: "string", enum: ["swd", "uart"] },
      requiredPrimitives: { type: "string" },
    });
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

  test("persists report drafts, revisions and finalization through the SSR action path", async () => {
    const calls: unknown[] = [];
    const plugin = createSoulInjectorPlugin({
      ...store(),
      createDebugReport: async (input) => { calls.push({ kind: "create", input }); return {} as never; },
      appendDebugReportRevision: async (input) => { calls.push({ kind: "append", input }); return {}; },
      finalizeDebugReport: async (reportId, projectId) => { calls.push({ kind: "finalize", reportId, projectId }); return null; },
    });
    const context = { requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: {} };
    await plugin.handleAction!["debugger"]!({ intent: "create_report", caseId: saved.id, reportTitle: "Initial diagnosis", reportContent: "Target halted unexpectedly" }, context);
    await plugin.handleAction!["debugger"]!({ intent: "append_report", reportId: saved.id, reportContent: "Additional register evidence" }, context);
    await plugin.handleAction!["debugger"]!({ intent: "finalize_report", reportId: saved.id }, context);
    expect(calls).toEqual([
      { kind: "create", input: { projectId: saved.projectId, caseId: saved.id, title: "Initial diagnosis", content: "Target halted unexpectedly", createdBy: saved.createdBy } },
      { kind: "append", input: { projectId: saved.projectId, reportId: saved.id, content: "Additional register evidence", createdBy: saved.createdBy } },
      { kind: "finalize", reportId: saved.id, projectId: saved.projectId },
    ]);
  });

  test("shows a bounded error state when the SSR target YAML is invalid", async () => {
    const plugin = createSoulInjectorPlugin({
      ...store(),
      saveTargetConfig: async () => { throw new TargetConfigError("targets.0.chip: invalid"); },
    });
    const action = await plugin.handleAction!["debugger"]!({ intent: "save_target", yaml: "invalid" }, { requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: {} });
    expect(action).toEqual({ redirect: `/plugins/${saved.installationId}/debugger?error=invalid_target_config` });
    const page = await plugin.render!["debugger"]!({ requestId: "request", installationId: saved.installationId, projectId: saved.projectId, user: { id: saved.createdBy, locale: "en", permissions: [] }, routeId: "debugger", params: { error: "invalid_target_config" } });
    expect(page.html).toContain("role=\"alert\"");
    expect(page.html).toContain("Target configuration is invalid");
  });

  test("renders a maximum-size target YAML within the SSR RPC budget", async () => {
    const largeYaml = `${saved.yaml}\n# ${"target-config ".repeat(4_300)}`.slice(0, 65_536);
    const plugin = createSoulInjectorPlugin({
      ...store(),
      getLatestTargetConfig: async () => ({ ...saved, yaml: largeYaml }),
    });
    const page = await plugin.render!["debugger"]!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      params: {},
    });
    expect(new TextEncoder().encode(page.html).byteLength).toBeLessThan(512 * 1024);
    expect(page.html).toContain("target-config target-config");
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

  test("creates a private session from a manager-only execution handoff without persisting the token", async () => {
    const created: unknown[] = [];
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const plugin = createSoulInjectorPlugin({
      ...store(),
      createDebugSession: async (input) => {
        created.push(input);
        return {
          id: sessionId,
          caseId: input.caseId,
          installationId: input.installationId,
          soulcloudDeviceRef: input.soulcloudDeviceRef,
          executionRef: input.executionRef ?? null,
          state: "active",
          pluginVersion: input.pluginVersion,
          manifestHash: input.manifestHash,
          deviceFirmwareVersion: input.deviceFirmwareVersion ?? null,
          targetConfigId: input.targetConfigId ?? null,
          targetConfigRevision: input.targetConfigRevision ?? null,
          targetId: input.targetId ?? null,
          artifactId: input.artifactId ?? null,
          startedBy: input.startedBy,
          controller: null,
          startedAt: saved.createdAt,
          endedAt: null,
        };
      },
    });
    const result = await plugin.startDebugSession!({
      operationId: "operation",
      installationId: saved.installationId,
      projectId: saved.projectId,
      deviceId: saved.installationId,
      userId: saved.createdBy,
      pluginVersion: "0.1.0",
      manifestHash: saved.sha256,
      executionId: "00000000-0000-4000-8000-000000000007",
      executionToken: "execution-token-that-must-not-be-persisted-1234567890",
      caseId: saved.id,
      targetConfigId: saved.id,
      targetConfigRevision: saved.revision,
      targetId: "fixture",
      artifactId: null,
      deviceFirmwareVersion: null,
    }, { signal: AbortSignal.timeout(1000) });
    expect(result).toEqual({ sessionId, executionId: "00000000-0000-4000-8000-000000000007" });
    expect(created[0]).not.toHaveProperty("executionToken");
    expect(created[0]).toMatchObject({ executionRef: "00000000-0000-4000-8000-000000000007", targetConfigId: saved.id, targetConfigRevision: 1, targetId: "fixture" });
  });

  test("marks only the scoped private session failed during manager cleanup", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const executionId = "00000000-0000-4000-8000-000000000007";
    const calls: unknown[] = [];
    const plugin = createSoulInjectorPlugin({
      ...store(),
      abortDebugSession: async (...input) => {
        calls.push(input);
        return {
          id: sessionId,
          caseId: saved.id,
          installationId: saved.installationId,
          soulcloudDeviceRef: saved.installationId,
          executionRef: executionId,
          state: "failed",
          pluginVersion: "0.1.0",
          manifestHash: saved.sha256,
          deviceFirmwareVersion: null,
          targetConfigId: null,
          targetConfigRevision: null,
          targetId: null,
          artifactId: null,
          startedBy: saved.createdBy,
          controller: null,
          startedAt: saved.createdAt,
          endedAt: saved.createdAt,
        };
      },
    });
    const result = await plugin.abortDebugSession!({
      operationId: "operation",
      installationId: saved.installationId,
      projectId: saved.projectId,
      deviceId: saved.installationId,
      executionId,
      sessionId,
      reason: "platform execution invalidated",
    }, { signal: AbortSignal.timeout(1_000) });
    expect(result).toEqual({ sessionId, executionId, state: "failed" });
    expect(calls).toEqual([[sessionId, executionId, saved.installationId, saved.projectId, saved.installationId]]);

    const resultWithoutSessionId = await plugin.abortDebugSession!({
      operationId: "operation",
      installationId: saved.installationId,
      projectId: saved.projectId,
      deviceId: saved.installationId,
      executionId,
      reason: "bootstrap response lost",
    }, { signal: AbortSignal.timeout(1_000) });
    expect(resultWithoutSessionId).toEqual({ sessionId, executionId, state: "failed" });
    expect(calls.at(-1)).toEqual([null, executionId, saved.installationId, saved.projectId, saved.installationId]);
  });

  test("renders private debugger session summaries without exposing execution credentials", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const plugin = createSoulInjectorPlugin({
      ...store(),
      listDebugSessions: async () => [{
        id: sessionId,
        caseId: saved.id,
        installationId: saved.installationId,
        soulcloudDeviceRef: "soulinjector-device-1",
        executionRef: "00000000-0000-4000-8000-000000000007",
        state: "active",
        pluginVersion: "0.1.0",
        manifestHash: saved.sha256,
        deviceFirmwareVersion: null,
        targetConfigId: null,
        targetConfigRevision: null,
        targetId: null,
        artifactId: null,
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

  test("renders an installation-scoped session observation timeline", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const session = {
      id: sessionId,
      caseId: saved.id,
      installationId: saved.installationId,
      soulcloudDeviceRef: "soulinjector-device-1",
      executionRef: "00000000-0000-4000-8000-000000000008",
      state: "active" as const,
      pluginVersion: "0.1.0",
      manifestHash: saved.sha256,
      deviceFirmwareVersion: null,
      targetConfigId: saved.id,
      targetConfigRevision: saved.revision,
      targetId: "fixture",
      artifactId: null,
      startedBy: saved.createdBy,
      controller: saved.createdBy,
      startedAt: saved.createdAt,
      endedAt: null,
    };
    let observationLimit = 0;
    const plugin = createSoulInjectorPlugin({
      ...store(),
      listDebugSessions: async () => [session],
      getDebugSession: async (id, installationId, projectId) => id === sessionId && installationId === saved.installationId && projectId === saved.projectId ? session : null,
      listDebugObservations: async (id, installationId, projectId, limit) => {
        observationLimit = limit ?? 0;
        return id === sessionId && installationId === saved.installationId && projectId === saved.projectId ? [{
          id: "00000000-0000-4000-8000-000000000007",
          sessionId,
          eventRef: "broker-event-1",
          source: "device",
          kind: "debug.log",
          structuredData: { message: "<target halted>" },
          artifactId: null,
          createdAt: saved.createdAt,
        }] : [];
      },
    });
    const result = await plugin.render!["debugger"]!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      params: { session_id: sessionId },
    });
    expect(result.html).toContain("Session timeline");
    expect(result.html).toContain("debug.log");
    expect(result.html).toContain("&lt;target halted&gt;");
    expect(result.html).not.toContain("<target halted>");
    expect(result.html).toContain('id="debug-actions"');
    expect(result.html).toContain('id="debug-command-timeline"');
    expect(result.html).toContain('id="debug-session-create"');
    expect(result.html).toContain('id="debug-session-device"');
    expect(result.html).toContain("Reports");
    expect(result.html).toContain('data-debug-action="debug.identify"');
    expect(result.html).toContain('data-debug-action="debug.reset"');
    expect(result.html).toContain('data-debug-action="debug.read_memory"');
    expect(result.html).toContain('id="debug-memory-address"');
    expect(result.html).toContain('id="debug-memory-length"');
    expect(result.html).toContain(`data-device-id="${session.soulcloudDeviceRef}"`);
    expect(observationLimit).toBe(16);
  });

  test("renders a bounded alert for the latest failed-session diagnostic", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000009";
    const session = {
      id: sessionId,
      caseId: saved.id,
      installationId: saved.installationId,
      soulcloudDeviceRef: "soulinjector-device-1",
      executionRef: "00000000-0000-4000-8000-000000000010",
      state: "failed" as const,
      pluginVersion: "0.1.0",
      manifestHash: saved.sha256,
      deviceFirmwareVersion: null,
      targetConfigId: saved.id,
      targetConfigRevision: saved.revision,
      targetId: "fixture",
      artifactId: null,
      startedBy: saved.createdBy,
      controller: saved.createdBy,
      startedAt: saved.createdAt,
      endedAt: saved.createdAt,
    };
    const plugin = createSoulInjectorPlugin({
      ...store(),
      listDebugSessions: async () => [session],
      getDebugSession: async () => session,
      listDebugObservations: async () => [{
        id: "00000000-0000-4000-8000-000000000011",
        sessionId,
        eventRef: "broker-event-error",
        source: "device",
        kind: "debug.status",
        structuredData: { state: "failed", error: "target <halted>\nprobe disconnected" },
        artifactId: null,
        createdAt: saved.createdAt,
      }],
    });
    const result = await plugin.render!["debugger"]!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      params: { session_id: sessionId },
    });
    expect(result.html).toContain('role="alert"');
    expect(result.html).toContain("Debugger error");
    expect(result.html).toContain('id="debug-command-timeline"');
    expect(result.html).toContain("target &lt;halted&gt;\nprobe disconnected");
    expect(result.html).not.toContain("target <halted>");
  });

  test("renders bounded target configuration revision metadata without YAML", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const result = await plugin.render!["debugger"]!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      params: {},
    });
    expect(result.html).toContain("Saved revisions");
    expect(result.html).toContain(`Revision ${saved.revision}`);
    expect(result.html).toContain(saved.sha256);
    expect(result.html).toContain("Artifacts");
    expect(result.html).toContain("fixture.elf");
    expect(result.html).toContain("&quot;elfClass&quot;:&quot;ELF64&quot;");
    expect(result.html).toContain('id="artifact-upload"');
    expect(result.html).toContain('id="artifact-file"');
    expect(result.html).toContain('id="artifact-kind"');
    expect(result.html).toContain('id="artifact-case"');
    expect(result.html).toContain('id="yaml-file"');
    expect(result.html).not.toContain("ELF header");
    expect(result.html).not.toContain("yaml_content");
  });

  test("keeps the client bundle bytes aligned with its manifest hash", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const asset = plugin.manifest.ui?.assets?.[0];
    expect(asset).toBeDefined();
    const renderAsset = plugin.assets?.[asset!.path];
    expect(renderAsset).toBeDefined();
    const result = await renderAsset!({
      requestId: "request",
      installationId: saved.installationId,
      projectId: saved.projectId,
      user: { id: saved.createdBy, locale: "en", permissions: [] },
      routeId: "debugger",
      assetPath: asset!.path,
      signal: AbortSignal.timeout(1000),
    });
    const body = new Uint8Array(result.body.byteLength);
    body.set(result.body);
    expect(new TextDecoder().decode(body)).toContain("Retrying…");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hash).toBe(asset!.sha256);
  });

  test("persists device observations idempotently by broker event id", async () => {
    const observations: unknown[] = [];
    const sessionStates: unknown[] = [];
    const plugin = createSoulInjectorPlugin({
      ...store(),
      updateDebugSessionState: async (input) => { sessionStates.push(input); return {} as never; },
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
    expect(sessionStates).toEqual([{ installationId: saved.installationId, projectId: saved.projectId, sessionId, soulcloudDeviceRef: saved.installationId, state: "active" }]);
    expect(observations).toEqual([{ installationId: saved.installationId, projectId: saved.projectId, sessionId, soulcloudDeviceRef: saved.installationId, eventRef: "broker-event-1", source: "device", kind: "debug.status", structuredData: { state: "running", sessionId } }]);
  });

  test("acknowledges a stale device event when its private session is gone", async () => {
    const plugin = createSoulInjectorPlugin({
      ...store(),
      updateDebugSessionState: async () => { throw new DebugSessionNotAvailableError(); },
      appendDebugObservation: async () => { throw new Error("observation must not be attempted after a missing session"); },
    });
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
      id: "broker-event-stale",
      seq: 2n,
      kind: "debug.status",
      schema: 1,
      receivedAt: new Date(0).toISOString(),
      payload: { state: "completed", sessionId: "00000000-0000-4000-8000-000000000005" },
      installation: { id: saved.installationId, projectId: saved.projectId, pluginId: "debugger", pluginVersion: "1.0.0", config: null },
      device: { id: saved.installationId, uid: "soulinjector-1", profileId: "debug", profileVersion: 1 },
    });
    expect(result.logs).toEqual([{ level: "warn", message: "ignored SoulInjector event for an unavailable debug session" }]);
    expect(result.updates).toEqual([{ entityKey: "debug.state", value: "completed" }, { entityKey: "debug.session_id", value: "00000000-0000-4000-8000-000000000005" }]);
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
    expect(result).toEqual([{ artifactId: saved.id, kind: "elf", filename: "fixture.elf", contentType: "application/octet-stream", size: 4, sha256: saved.sha256, metadata: { format: "elf", elfClass: "ELF64", machine: 243 }, createdAt: saved.createdAt }]);
    expect(result[0]).not.toHaveProperty("content");
  });

  test("passes artifact chunks to the private store", async () => {
    const plugin = createSoulInjectorPlugin(store());
    const result = await plugin.storeArtifactChunk!({ operationId: "operation", installationId: saved.installationId, projectId: saved.projectId, userId: saved.createdBy, uploadId: saved.id, kind: "firmware", filename: "image.bin", contentType: "application/octet-stream", totalSize: 3, offset: 0, final: true, chunk: Uint8Array.of(1, 2, 3) }, { signal: AbortSignal.timeout(1000) });
    expect(result).toMatchObject({ uploadId: saved.id, receivedBytes: 3, complete: true, artifactId: saved.id });
  });

  test("reads bounded artifact chunks without exposing the complete blob", async () => {
    const chunk = Uint8Array.of(1, 2, 3);
    const plugin = createSoulInjectorPlugin({
      ...store(),
      readArtifactChunk: async (artifactId, installationId, projectId, offset, length) => {
        expect({ artifactId, installationId, projectId, offset, length }).toEqual({ artifactId: saved.id, installationId: saved.installationId, projectId: saved.projectId, offset: 4, length: 8 });
        return { artifactId: saved.id, offset: 4, totalSize: 7, sha256: saved.sha256, chunk, final: true };
      },
    });
    const result = await plugin.readArtifactChunk!({
      operationId: "operation",
      installationId: saved.installationId,
      projectId: saved.projectId,
      userId: saved.createdBy,
      artifactId: saved.id,
      offset: 4,
      length: 8,
    }, { signal: AbortSignal.timeout(1000) });
    expect(result).toMatchObject({ artifactId: saved.id, offset: 4, totalSize: 7, final: true });
    expect(result.chunk).toEqual(chunk);
  });
});
