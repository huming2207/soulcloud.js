/**
 * Command poller tests: startCommandPoller drives pollOnce on wake and
 * stops cleanly. A real broker is started on a dedicated port (the test
 * suite runs files in parallel on the isolated test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { enqueueBatch, prisma } from "@soulcloud/core";
import { startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { startCommandPoller } from "../../src/mqtt/publish";

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };
const POLLER_PORT = 18884;

let broker: BrokerHandle;
let projectId: string;
let deviceId: string;

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "poller-test-project" },
  });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: `poller-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-poller",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
  broker = await startBroker(prisma, { port: POLLER_PORT });
});

afterAll(async () => {
  await broker.close();
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
});

describe("startCommandPoller", () => {
  test("wake() polls: an offline device command is deferred back to queued", async () => {
    const poller = startCommandPoller(
      broker.aedes,
      prisma,
      { pollIntervalMs: 60_000, leaseDurationMs: 60_000, retain: false },
      silentLog,
    );
    try {
      const batch = await enqueueBatch(prisma, [deviceId], { cmd: "reboot" });
      const before = await prisma.deviceCommand.findFirstOrThrow({
        where: { batchId: batch.id },
      });
      expect(before.state).toBe("queued");
      poller.wake();
      // the poll leases the command, sees the device offline and defers
      // it back to queued (offlineRetryMs backoff) — attempt count 1
      await new Promise((r) => setTimeout(r, 300));
      const after = await prisma.deviceCommand.findFirstOrThrow({
        where: { batchId: batch.id },
      });
      expect(after.state).toBe("queued");
      expect(after.attemptCount).toBe(1);
      expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      poller.stop();
    }
  });

  test("a stopped poller no longer processes commands", async () => {
    const poller = startCommandPoller(
      broker.aedes,
      prisma,
      { pollIntervalMs: 50, leaseDurationMs: 60_000, retain: false },
      silentLog,
    );
    poller.stop();
    const batch = await enqueueBatch(prisma, [deviceId], { cmd: "reboot" });
    await new Promise((r) => setTimeout(r, 200));
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });
    expect(row.state).toBe("queued");
  });

  test("stop() can be called repeatedly", () => {
    const poller = startCommandPoller(
      broker.aedes,
      prisma,
      { pollIntervalMs: 60_000, leaseDurationMs: 60_000, retain: false },
      silentLog,
    );
    poller.stop();
    poller.stop();
  });
});
