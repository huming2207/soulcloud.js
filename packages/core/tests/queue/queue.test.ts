import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import { enqueueBatch } from "../../src/queue/enqueue";
import { leaseNext } from "../../src/queue/lease";
import { markBrokerAccepted, releaseLease } from "../../src/queue/acknowledge";
import { recordDeviceResult } from "../../src/queue/result";
import { CommandQueueError } from "../../src/queue/errors";
import { decodeDeviceCommandExecution, encodeDeviceCommandResult } from "../../src/protocol/command";

// Integration tests against the local development PostgreSQL.
// Requires: docker compose up -d postgres && bunx prisma migrate deploy

let projectId: string;
const deviceIds: string[] = [];
const deviceUids: string[] = [];

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "queue-test-project" },
  });
  for (let i = 0; i < 3; i++) {
    const uid = `qt-${i}-${randomUUID().slice(0, 8)}`;
    const device = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: `assigned-${i}`,
        passwordHash: "unused-hash",
        projectId,
      },
    });
    deviceIds.push(device.id);
    deviceUids.push(uid);
  }
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`; // cascades device_commands
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
});

// Each test starts with an empty command queue and fresh device sequences so
// tests are independent of each other.
beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.$executeRaw`UPDATE devices SET next_command_sequence = 1`;
});

describe("enqueueBatch", () => {
  test("atomically creates a batch with per-device sequences", async () => {
    const batch = await enqueueBatch(prisma, deviceIds, {
      cmd: "setLogging",
      args: [{ enabled: true }],
    });
    expect(batch.deviceCount).toBe(3);

    const commands = await prisma.deviceCommand.findMany({
      where: { batchId: batch.id },
      orderBy: { sequence: "asc" },
    });
    expect(commands).toHaveLength(3);
    expect(commands.map((c) => c.sequence)).toEqual([1n, 1n, 1n]);
    expect(commands.every((c) => c.state === "queued")).toBe(true);

    for (const c of commands) {
      const decoded = decodeDeviceCommandExecution(c.payload);
      expect(decoded.seq).toBe(c.sequence);
      expect(decoded.id).toHaveLength(16);
      expect(decoded.cmd).toBe("setLogging");
    }

    // second batch bumps per-device sequences
    const batch2 = await enqueueBatch(prisma, [deviceIds[0]!], { cmd: "reboot" });
    const cmd2 = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch2.id },
    });
    expect(cmd2.sequence).toBe(2n);
  });

  test("rejects empty and duplicate targets", async () => {
    await expect(enqueueBatch(prisma, [], { cmd: "reboot" })).rejects.toThrow(
      CommandQueueError,
    );
    await expect(
      enqueueBatch(prisma, [deviceIds[0]!, deviceIds[0]!], { cmd: "reboot" }),
    ).rejects.toThrow(CommandQueueError);
  });

  test("rejects missing targets", async () => {
    const missing = randomUUID();
    await expect(
      enqueueBatch(prisma, [missing], { cmd: "reboot" }),
    ).rejects.toMatchObject({ kind: "missing_targets" });
  });

  test("rejects devices with unsafe UIDs", async () => {
    const badDevice = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: "bad/uid",
        assignedId: "assigned-bad",
        passwordHash: "unused-hash",
        projectId,
      },
    });
    await expect(
      enqueueBatch(prisma, [badDevice.id], { cmd: "reboot" }),
    ).rejects.toMatchObject({ kind: "invalid_device_uid" });
  });
});

describe("leaseNext", () => {
  test("leases the oldest eligible command and bumps attempt count", async () => {
    await enqueueBatch(prisma, [deviceIds[1]!], { cmd: "reboot" });
    const leased = await leaseNext(prisma, 60_000);
    expect(leased).not.toBeNull();
    expect(leased!.attemptCount).toBe(1);

    const row = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: leased!.id },
    });
    expect(row.state).toBe("leased");
    expect(row.leaseExpiresAt).not.toBeNull();
    await releaseLease(prisma, leased!.id);
  });

  test("does not re-lease an active command before expiry", async () => {
    await enqueueBatch(prisma, [deviceIds[1]!], { cmd: "reboot" });
    const leased = await leaseNext(prisma, 60_000);
    expect(leased).not.toBeNull();
    const second = await leaseNext(prisma, 60_000);
    expect(second).toBeNull();
    await releaseLease(prisma, leased!.id);
    const third = await leaseNext(prisma, 60_000);
    expect(third).not.toBeNull();
    await releaseLease(prisma, third!.id);
  });

  test("releases expired leases", async () => {
    await enqueueBatch(prisma, [deviceIds[1]!], { cmd: "reboot" });
    const leased = await leaseNext(prisma, 1);
    expect(leased).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const again = await leaseNext(prisma, 60_000);
    expect(again).not.toBeNull();
    expect(again!.id).toBe(leased!.id);
    expect(again!.attemptCount).toBe(2);
    await releaseLease(prisma, again!.id);
  });

  test("preserves per-device order", async () => {
    const batch = await enqueueBatch(prisma, [deviceIds[2]!], { cmd: "first" });
    await enqueueBatch(prisma, [deviceIds[2]!], { cmd: "second" });
    const first = await leaseNext(prisma, 60_000);
    // while the first command is active, the second must NOT be claimable
    const second = await leaseNext(prisma, 60_000);
    expect(second).toBeNull();
    // broker_accepted STILL blocks later commands (contract: only
    // device_completed unblocks the per-device queue)
    await markBrokerAccepted(prisma, first!.id);
    expect(await leaseNext(prisma, 60_000)).toBeNull();
    // completing the first command unblocks the second
    const firstRow = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: first!.id },
    });
    const firstDecoded = decodeDeviceCommandExecution(firstRow.payload);
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: deviceIds[2]! },
    });
    await recordDeviceResult(prisma, device.deviceUid, {
      id: firstDecoded.id,
      seq: firstDecoded.seq,
      code: 0,
    }, Buffer.from(encodeDeviceCommandResult({ id: firstDecoded.id, seq: firstDecoded.seq, code: 0 })));
    const third = await leaseNext(prisma, 60_000);
    expect(third).not.toBeNull();
    const thirdRow = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: third!.id },
    });
    expect(thirdRow.batchId).not.toBe(batch.id);
    await markBrokerAccepted(prisma, third!.id);
  });
});

describe("markBrokerAccepted / releaseLease", () => {
  test("markBrokerAccepted transitions leased -> broker_accepted", async () => {
    await enqueueBatch(prisma, [deviceIds[0]!], { cmd: "reboot" });
    const leased = await leaseNext(prisma, 60_000);
    expect(leased).not.toBeNull();
    await markBrokerAccepted(prisma, leased!.id);
    const row = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: leased!.id },
    });
    expect(row.state).toBe("broker_accepted");
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.brokerAcceptedAt).not.toBeNull();
    // idempotent
    await markBrokerAccepted(prisma, leased!.id);
  });

  test("markBrokerAccepted fails on non-leased command", async () => {
    const batch = await enqueueBatch(prisma, [deviceIds[0]!], { cmd: "reboot" });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });
    await expect(markBrokerAccepted(prisma, row.id)).rejects.toMatchObject({
      kind: "lease_conflict",
    });
  });

  test("releaseLease fails on non-leased command", async () => {
    const batch = await enqueueBatch(prisma, [deviceIds[0]!], { cmd: "reboot" });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });
    await expect(releaseLease(prisma, row.id)).rejects.toMatchObject({
      kind: "lease_conflict",
    });
  });
});

describe("recordDeviceResult", () => {
  async function enqueueOne(deviceIdx: number, cmd: string) {
    const batch = await enqueueBatch(prisma, [deviceIds[deviceIdx]!], { cmd });
    return prisma.deviceCommand.findFirstOrThrow({ where: { batchId: batch.id } });
  }

  function resultPacket(row: { payload: Uint8Array }) {
    const decoded = decodeDeviceCommandExecution(row.payload);
    return Buffer.from(encodeDeviceCommandResult({
      id: decoded.id,
      seq: decoded.seq,
      code: 0,
    }));
  }

  test("records a result and completes the command (from queued)", async () => {
    const row = await enqueueOne(0, "getConfig");
    const decoded = decodeDeviceCommandExecution(row.payload);
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: row.deviceId },
    });
    const packet = resultPacket(row);

    const outcome = await recordDeviceResult(
      prisma,
      device.deviceUid,
      { id: decoded.id, seq: decoded.seq, code: 0 },
      packet,
    );
    expect(outcome).toBe("recorded");

    const completed = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(completed.state).toBe("device_completed");
    expect(completed.resultCode).toBe(0);
    expect(completed.resultPacket).toEqual(packet);
    expect(completed.deviceCompletedAt).not.toBeNull();
    expect(completed.brokerAcceptedAt).not.toBeNull(); // result proves broker acceptance
  });

  test("repeated identical result is idempotent", async () => {
    const row = await enqueueOne(0, "reboot");
    const decoded = decodeDeviceCommandExecution(row.payload);
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: row.deviceId },
    });
    const packet = resultPacket(row);

    await recordDeviceResult(prisma, device.deviceUid, {
      id: decoded.id,
      seq: decoded.seq,
      code: 0,
    }, packet);
    const again = await recordDeviceResult(prisma, device.deviceUid, {
      id: decoded.id,
      seq: decoded.seq,
      code: 0,
    }, packet);
    expect(again).toBe("already_recorded");
  });

  test("conflicting result is rejected", async () => {
    const row = await enqueueOne(0, "reboot");
    const decoded = decodeDeviceCommandExecution(row.payload);
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: row.deviceId },
    });
    const packet = resultPacket(row);

    await recordDeviceResult(prisma, device.deviceUid, {
      id: decoded.id,
      seq: decoded.seq,
      code: 0,
    }, packet);
    await expect(
      recordDeviceResult(prisma, device.deviceUid, {
        id: decoded.id,
        seq: decoded.seq,
        code: -1, // different code
      }, packet),
    ).rejects.toMatchObject({ kind: "conflicting_result" });
  });

  test("mismatched device or sequence is rejected", async () => {
    const row = await enqueueOne(1, "reboot");
    const decoded = decodeDeviceCommandExecution(row.payload);
    const otherDevice = await prisma.device.findUniqueOrThrow({
      where: { id: deviceIds[0]! },
    });

    await expect(
      recordDeviceResult(prisma, otherDevice.deviceUid, {
        id: decoded.id,
        seq: decoded.seq,
        code: 0,
      }, row.payload),
    ).rejects.toMatchObject({ kind: "result_mismatch" });

    await expect(
      recordDeviceResult(prisma, deviceUids[1]!, {
        id: decoded.id,
        seq: decoded.seq + 1n,
        code: 0,
      }, row.payload),
    ).rejects.toMatchObject({ kind: "result_mismatch" });
  });

  test("unknown command ID is rejected", async () => {
    await expect(
      recordDeviceResult(prisma, deviceUids[0]!, {
        id: new Uint8Array(16).fill(0xee),
        seq: 1n,
        code: 0,
      }, Buffer.alloc(0)),
    ).rejects.toMatchObject({ kind: "result_mismatch" });
  });
});

describe("M8: concurrent enqueue ordering", () => {
  test("per-device lease order follows sequence, not transaction start", async () => {
    // fire two enqueues concurrently; whichever commits second must NOT be
    // delivered before the first (sequence order preserved)
    const [b1, b2] = await Promise.all([
      enqueueBatch(prisma, [deviceIds[0]!], { cmd: "first" }),
      enqueueBatch(prisma, [deviceIds[0]!], { cmd: "second" }),
    ]);
    const rows = await prisma.deviceCommand.findMany({
      where: { deviceId: deviceIds[0]!, batchId: { in: [b1.id, b2.id] } },
      orderBy: { sequence: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.sequence).toBeLessThan(rows[1]!.sequence);

    // the oldest sequence must be leased first, and the second must stay
    // blocked until the first completes
    const first = await leaseNext(prisma, 60_000);
    expect(first).not.toBeNull();
    const firstRow = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: first!.id },
    });
    expect(firstRow.sequence).toBe(rows[0]!.sequence);
    expect(await leaseNext(prisma, 60_000)).toBeNull();
    await releaseLease(prisma, first!.id);
  });
});
