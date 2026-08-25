import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPluginInstallation, prisma } from "@soulcloud/core";
import { PluginManager } from "../src/manager";

const projectId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const pluginId = `test.debug.bootstrap.${randomUUID()}`;
const pluginVersion = "1.0.0";
const manifestHash = "a".repeat(64);
let installationId: string;

beforeAll(async () => {
  await prisma.project.create({ data: { id: projectId, name: "debug bootstrap test" } });
  await prisma.user.create({ data: { id: userId, username: `debug-bootstrap-${randomUUID()}`, email: `${randomUUID()}@example.invalid`, passwordHash: "unused" } });
  await prisma.userProject.create({ data: { userId, projectId } });
  await prisma.device.create({ data: { id: deviceId, projectId, deviceUid: `debug-bootstrap-${randomUUID()}`, assignedId: "debug-bootstrap-device", passwordHash: "unused" } });
  await prisma.pluginManifestSnapshot.create({
    data: {
      pluginId,
      pluginVersion,
      manifestHash,
      apiVersion: 1,
      canonicalManifest: {
        id: pluginId,
        version: pluginVersion,
        apiVersion: 1,
        profiles: [{ id: "debug", version: 1, manufacturer: "test", model: "test", capabilities: [], entities: [] }],
        actions: [],
        events: [],
      },
    },
  });
  installationId = (await createPluginInstallation(prisma, { projectId, pluginId, pluginVersion, manifestHash, config: null })).id;
  await prisma.pluginDeviceBinding.create({ data: { deviceId, installationId, profileId: "debug", profileVersion: 1 } });
});

afterAll(async () => {
  await prisma.debugExecution.deleteMany({ where: { installationId } });
  await prisma.pluginDeviceBinding.deleteMany({ where: { deviceId } });
  await prisma.pluginInstallation.delete({ where: { id: installationId } });
  await prisma.pluginManifestSnapshot.delete({ where: { pluginId_pluginVersion: { pluginId, pluginVersion } } });
  await prisma.device.delete({ where: { id: deviceId } });
  await prisma.userProject.delete({ where: { userId_projectId: { userId, projectId } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.project.delete({ where: { id: projectId } });
});

describe("debug session bootstrap cleanup", () => {
  test("aborts a private session when the plugin echoes the wrong execution ID", async () => {
    const sessionId = randomUUID();
    const wrongExecutionId = randomUUID();
    let startedExecutionId: string | undefined;
    let abortInput: { sessionId?: string; executionId?: string } | undefined;
    const connection = {
      id: "debug-bootstrap-connection",
      isOpen: true,
      manifest: { pluginId, pluginVersion, manifestHash },
      request: async (method: string, input: { executionId: string; sessionId?: string }) => {
        if (method === "debugger.startSession") {
          startedExecutionId = input.executionId;
          return { sessionId, executionId: wrongExecutionId };
        }
        if (method === "debugger.abortSession") {
          abortInput = input;
          return { sessionId: input.sessionId, executionId: input.executionId, state: "failed" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "debug-bootstrap-manager-token-that-is-long-enough",
      maxFrameBytes: 1_048_576,
      maxPendingRequests: 8,
      backpressureBytes: 1_048_576,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      prisma,
    });
    const internals = manager as unknown as {
      connections: Map<string, typeof connection>;
      catalog: Map<string, unknown>;
    };
    internals.connections.set(pluginId, connection);
    internals.catalog.set(`${pluginId}@${pluginVersion}`, {
      pluginId,
      pluginVersion,
      manifestHash,
      manifest: {
        id: pluginId,
        version: pluginVersion,
        apiVersion: 1,
        profiles: [],
        actions: [],
        events: [],
      },
      connected: true,
    });

    await expect(manager.startDebugSession({
      installationId,
      projectId,
      deviceId,
      userId,
      caseId: randomUUID(),
      leaseMs: 5_000,
      ttlMs: 60_000,
    })).rejects.toThrow("different debug execution id");

    expect(startedExecutionId).toBeString();
    expect(abortInput).toMatchObject({ sessionId, executionId: startedExecutionId });
    const execution = await prisma.debugExecution.findFirstOrThrow({ where: { installationId } });
    expect(execution.state).toBe("failed");
  });
});
