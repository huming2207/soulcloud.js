import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  completeDebugExecution,
  createDebugExecution,
  DebugExecutionConflictError,
  expireDebugExecutions,
  getDebugExecutionCapability,
  releaseDebugExecution,
  renewDebugExecutionLease,
} from "../../src/plugins/executions";
import {
  DebugCommandIdempotencyConflictError,
  enqueueDebugCommand,
  getDebugCommand,
  requestDebugCommandCancellation,
} from "../../src/plugins/execution-commands";
import { createPluginInstallation } from "../../src/plugins/installations";

const projectId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const pluginId = `test.debug.execution.${randomUUID()}`;
const manifestHash = "a".repeat(64);
const tokenHashA = "b".repeat(64);
const tokenHashB = "c".repeat(64);
const tokenHashC = "d".repeat(64);
const tokenHashD = "e".repeat(64);
const tokenHashE = "f".repeat(64);
const tokenHashF = "1".repeat(64);
let installationId: string;

beforeAll(async () => {
  await prisma.project.create({ data: { id: projectId, name: "debug execution test" } });
  await prisma.user.create({ data: { id: userId, username: `debug-execution-${randomUUID()}`, email: `${randomUUID()}@example.invalid`, passwordHash: "unused" } });
  await prisma.userProject.create({ data: { userId, projectId } });
  await prisma.device.create({ data: { id: deviceId, projectId, deviceUid: `debug-execution-${randomUUID()}`, assignedId: "debug-execution-device", passwordHash: "unused" } });
  await prisma.pluginManifestSnapshot.create({
    data: {
      pluginId,
      pluginVersion: "1.0.0",
      manifestHash,
      apiVersion: 1,
      canonicalManifest: {
        id: pluginId,
        version: "1.0.0",
        apiVersion: 1,
        profiles: [{ id: "debug", version: 1, manufacturer: "test", model: "test", capabilities: [], entities: [] }],
        actions: [],
        events: [],
      },
    },
  });
  installationId = (await createPluginInstallation(prisma, { projectId, pluginId, pluginVersion: "1.0.0", manifestHash, config: null })).id;
  await prisma.pluginDeviceBinding.create({ data: { deviceId, installationId, profileId: "debug", profileVersion: 1 } });
});

afterAll(async () => {
  const commandRows = await prisma.deviceCommand.findMany({ where: { deviceId }, select: { id: true, batchId: true } });
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  if (commandRows.length > 0) await prisma.commandBatch.deleteMany({ where: { id: { in: commandRows.map((row) => row.batchId) } } });
  await prisma.debugExecution.deleteMany({ where: { installationId } });
  await prisma.pluginDeviceBinding.deleteMany({ where: { deviceId } });
  await prisma.pluginInstallation.delete({ where: { id: installationId } });
  await prisma.pluginManifestSnapshot.deleteMany({ where: { pluginId } });
  await prisma.device.delete({ where: { id: deviceId } });
  await prisma.userProject.delete({ where: { userId_projectId: { userId, projectId } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.project.delete({ where: { id: projectId } });
});

function input(tokenHash: string, ttlMs = 60_000, allowedCapabilities: readonly string[] = ["debug.read", "debug.read", "debug.observe"]) {
  return {
    installationId,
    deviceId,
    initiatingUserId: userId,
    pluginId,
    pluginVersion: "1.0.0",
    manifestHash,
    allowedCapabilities,
    tokenHash,
    leaseMs: 5_000,
    ttlMs,
  } as const;
}

describe("durable debug execution capability", () => {
  test("creates one device lease and normalizes capability names", async () => {
    const execution = await createDebugExecution(prisma, input(tokenHashA));
    expect(execution).toMatchObject({
      installationId,
      deviceId,
      initiatingUserId: userId,
      state: "active",
      allowedCapabilities: ["debug.observe", "debug.read"],
    });
    expect(execution.deviceLeaseExpiresAt).not.toBeNull();
    expect("tokenHash" in execution).toBe(false);
    await expect(createDebugExecution(prisma, input(tokenHashB))).rejects.toBeInstanceOf(DebugExecutionConflictError);
  });

  test("renews, releases and completes using the raw-token hash", async () => {
    const renewed = await renewDebugExecutionLease(prisma, await executionIdFor(tokenHashA), tokenHashA, 10_000);
    expect(renewed.state).toBe("active");
    const released = await releaseDebugExecution(prisma, renewed.id, tokenHashA);
    expect(released.state).toBe("paused");
    expect(released.deviceLeaseExpiresAt).toBeNull();
    expect(await getDebugExecutionCapability(prisma, released.id, tokenHashA)).not.toBeNull();

    const second = await createDebugExecution(prisma, input(tokenHashB));
    await expect(completeDebugExecution(prisma, second.id, tokenHashC, "completed")).rejects.toThrow("invalid or expired");
    const completed = await completeDebugExecution(prisma, second.id, tokenHashB, "completed");
    expect(completed.state).toBe("completed");
    expect(await getDebugExecutionCapability(prisma, second.id, tokenHashB)).toBeNull();
  });

  test("expires execution TTL and releases an expired device lease with database time", async () => {
    const third = await createDebugExecution(prisma, input(tokenHashC));
    await prisma.$executeRaw`UPDATE debug_executions SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ${third.id}::uuid`;
    expect((await expireDebugExecutions(prisma)).executions).toBe(1);
    const expired = await prisma.debugExecution.findUniqueOrThrow({ where: { id: third.id } });
    expect(expired.state).toBe("expired");
    expect(expired.deviceLeaseExpiresAt).toBeNull();

    const fourth = await createDebugExecution(prisma, input(tokenHashD));
    await prisma.$executeRaw`UPDATE debug_executions SET device_lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ${fourth.id}::uuid`;
    expect((await expireDebugExecutions(prisma)).leases).toBe(1);
    const paused = await prisma.debugExecution.findUniqueOrThrow({ where: { id: fourth.id } });
    expect(paused.state).toBe("paused");
    expect(paused.deviceLeaseExpiresAt).toBeNull();
  });

  test("enqueues, reads and requests cancellation for a command under the execution lease", async () => {
    const execution = await createDebugExecution(prisma, input(tokenHashE, 60_000, ["device.enqueue_command", "device.get_command", "device.cancel_command"]));
    const command = await enqueueDebugCommand(prisma, {
      executionId: execution.id,
      tokenHash: tokenHashE,
      pluginId,
      pluginVersion: "1.0.0",
      manifestHash,
      initiatingUserId: userId,
      command: { cmd: "debug.identify", args: [] },
    });
    expect(command.state).toBe("queued");
    expect(command.sequence).toBeGreaterThan(0n);
    expect(await getDebugCommand(prisma, execution.id, tokenHashE, command.id)).toMatchObject({ id: command.id, deviceId });
    const cancelled = await requestDebugCommandCancellation(prisma, execution.id, tokenHashE, command.id);
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    const idempotentInput = {
      executionId: execution.id,
      tokenHash: tokenHashE,
      pluginId,
      pluginVersion: "1.0.0",
      manifestHash,
      initiatingUserId: userId,
      command: { cmd: "debug.identify", args: [{ probe: new Uint8Array([1, 2, 3]) }] },
      correlationId: execution.id,
      idempotencyKey: "identify-once",
    };
    const firstIdempotent = await enqueueDebugCommand(prisma, idempotentInput);
    const repeatedIdempotent = await enqueueDebugCommand(prisma, idempotentInput);
    expect(repeatedIdempotent.id).toBe(firstIdempotent.id);
    await expect(enqueueDebugCommand(prisma, {
      ...idempotentInput,
      command: { cmd: "debug.reset", args: [] },
    })).rejects.toBeInstanceOf(DebugCommandIdempotencyConflictError);

    await completeDebugExecution(prisma, execution.id, tokenHashE, "completed");

    const noReadCapability = await createDebugExecution(prisma, input(tokenHashF, 60_000, ["device.enqueue_command", "device.cancel_command"]));
    const commandWithoutReadCapability = await enqueueDebugCommand(prisma, {
      executionId: noReadCapability.id,
      tokenHash: tokenHashF,
      pluginId,
      pluginVersion: "1.0.0",
      manifestHash,
      initiatingUserId: userId,
      command: { cmd: "debug.identify", args: [] },
    });
    const cancelledWithoutReadCapability = await requestDebugCommandCancellation(
      prisma,
      noReadCapability.id,
      tokenHashF,
      commandWithoutReadCapability.id,
    );
    expect(cancelledWithoutReadCapability.cancelRequestedAt).not.toBeNull();
  });
});

async function executionIdFor(tokenHash: string): Promise<string> {
  const execution = await prisma.debugExecution.findUniqueOrThrow({ where: { tokenHash } });
  return execution.id;
}
