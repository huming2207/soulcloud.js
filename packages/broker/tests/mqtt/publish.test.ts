/**
 * Command poller tests: startCommandPoller drives pollOnce on wake and
 * stops cleanly. A real broker is started on a dedicated port (the test
 * suite runs files in parallel on the isolated test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { enqueueBatch, hashDevicePassword, prisma } from "@soulcloud/core";
import { acquireLeaseLock } from "../../../core/tests/helpers/lease-lock";
import { startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { DEFAULT_DRAIN_MAX_PER_CYCLE, startCommandPoller } from "../../src/mqtt/publish";
import { MqttTestClient } from "../helpers/mqtt-client";

// pollOnce leases ANY queued command (global scan), so this file must be
// serialized against the other lease-touching files (queue/broker/ota)
// or parallel tests can steal the commands under test
await acquireLeaseLock(prisma);

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };
const POLLER_PORT = 18884;

let broker: BrokerHandle;
let projectId: string;
let deviceId: string;
/** Devices with a real password hash, used for real MQTT connections
 * (the default `deviceId` uses "unused" and is only ever enqueued to).
 * Five of them: the drain test needs several devices because the lease
 * query enforces per-device FIFO (M8) — a device's later commands are
 * blocked while an earlier command is in broker_accepted. */
let liveDevices: { id: string; uid: string }[] = [];
const LIVE_DEVICE_PASSWORD = "secret";

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
  for (let i = 0; i < 5; i++) {
    const uid = `live-${randomUUID().slice(0, 8)}`;
    const live = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: `assigned-live-${i}`,
        passwordHash: await hashDevicePassword(LIVE_DEVICE_PASSWORD),
        projectId,
      },
    });
    liveDevices.push({ id: live.id, uid });
  }
  broker = await startBroker(prisma, { port: POLLER_PORT });
});

afterAll(async () => {
  await broker.close();
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  await prisma.deviceCommand.deleteMany({ where: { deviceId: { in: liveDevices.map((d) => d.id) } } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  await prisma.deviceCommand.deleteMany({ where: { deviceId: { in: liveDevices.map((d) => d.id) } } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
});

/** Connects a real MQTT client for a live-test device (no auto-subscribe:
 * the WEB-01 test needs the CONNECT-but-not-SUBSCRIBED window). */
function connectLiveDevice(device: { id: string; uid: string }): Promise<MqttTestClient> {
  const client = new MqttTestClient(`ws://127.0.0.1:${POLLER_PORT}/mqtt`, {
    clientId: device.uid,
    username: device.uid,
    password: LIVE_DEVICE_PASSWORD,
  });
  return client.connect().then(() => client);
}

/** Polls a predicate until it is true (replaces fixed sleeps; avoids flaky
 * timing-dependent assertions on asynchronous DB writes). */
async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe("startCommandPoller", () => {
  test("wake() polls: an offline device command is deferred back to queued", async () => {
    const poller = startCommandPoller(
      broker.registry,
      broker.aedes,
      prisma,
      { pollIntervalMs: 100, leaseDurationMs: 60_000, retain: false },
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
      // it back to queued (offlineRetryMs backoff) — attempt count 1.
      // Poll for the deferred state instead of a fixed sleep: the lease +
      // defer writes can lag past a sleep window under parallel load.
      await waitFor(async () => {
        const row = await prisma.deviceCommand.findFirst({ where: { batchId: batch.id } });
        return row?.state === "queued" && row.attemptCount === 1;
      }, "command deferred back to queued with attempt count 1");
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
      broker.registry,
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
      broker.registry,
      broker.aedes,
      prisma,
      { pollIntervalMs: 60_000, leaseDurationMs: 60_000, retain: false },
      silentLog,
    );
    poller.stop();
    poller.stop();
  });

  test("a command is not marked accepted before the device subscribes (WEB-01)", async () => {
    // esp-mqtt subscribes asynchronously after CONNACK; enqueue while the
    // device is connected but its SUBSCRIBE is still in flight. The poller
    // must defer the command (queued, attempt 1) instead of publishing
    // into the void and marking it broker_accepted — a silently-dropped
    // publish would strand the command in broker_accepted forever and,
    // via the per-device FIFO, block every later command for the device.
    const device = liveDevices[0]!;
    const client = await connectLiveDevice(device);
    try {
      const poller = startCommandPoller(
        broker.registry,
        broker.aedes,
        prisma,
        // short interval: the unsubscribed defer backs off 1s; the
        // interval poller must pick the command up again after the
        // subscription registers (a 60s interval + single wake would
        // lease nothing while the backoff is still pending)
        { pollIntervalMs: 100, leaseDurationMs: 60_000, retain: false },
        silentLog,
      );
      try {
        const batch = await enqueueBatch(prisma, [device.id], { cmd: "reboot" });
        const commandId = (
          await prisma.deviceCommand.findFirstOrThrow({ where: { batchId: batch.id } })
        ).id;

        poller.wake();
        await waitFor(async () => {
          const row = await prisma.deviceCommand.findUnique({ where: { id: commandId } });
          return row?.state === "queued" && row.attemptCount === 1;
        }, "command deferred while unsubscribed");
        const deferred = await prisma.deviceCommand.findUniqueOrThrow({
          where: { id: commandId },
        });
        expect(deferred.state).toBe("queued");
        expect(deferred.availableAt.getTime()).toBeGreaterThan(Date.now());

        // once the subscription is registered a later poll delivers it
        await client.subscribe(`soulcloud/v1/devices/${device.uid}/cmd/exec`);
        await waitFor(async () => {
          const row = await prisma.deviceCommand.findUnique({ where: { id: commandId } });
          return row?.state === "broker_accepted";
        }, "command accepted after subscribe");
      } finally {
        poller.stop();
      }
    } finally {
      client.end();
    }
  });

  test("a poll cycle drains multiple queued commands across devices (WEB-05)", async () => {
    // five devices, one command each: the per-device FIFO (M8) would block
    // a second command behind a first in broker_accepted on the same
    // device, so cross-device commands are the right drain workload
    const clients: MqttTestClient[] = [];
    try {
      for (const device of liveDevices) {
        const client = await connectLiveDevice(device);
        clients.push(client);
        await client.subscribe(`soulcloud/v1/devices/${device.uid}/cmd/exec`);
      }
      const poller = startCommandPoller(
        broker.registry,
        broker.aedes,
        prisma,
        {
          pollIntervalMs: 60_000,
          leaseDurationMs: 60_000,
          retain: false,
          // small budget: the drain must deliver the whole batch across
          // repeated cycles, not just one command per cycle
          drainMaxPerCycle: 2,
        },
        silentLog,
      );
      try {
        const ids: string[] = [];
        for (const device of liveDevices) {
          const batch = await enqueueBatch(prisma, [device.id], { cmd: "reboot" });
          ids.push((await prisma.deviceCommand.findFirstOrThrow({ where: { batchId: batch.id } })).id);
        }
        // one wake drives one drain cycle (budget 2); the fixed interval
        // (60s) is never reached, so repeated wakes must drain the rest
        for (let i = 0; i < 4; i++) {
          poller.wake();
          await new Promise((r) => setTimeout(r, 300));
        }
        await waitFor(async () => {
          const rows = await prisma.deviceCommand.findMany({ where: { id: { in: ids } } });
          return rows.length === 5 && rows.every((r) => r.state === "broker_accepted");
        }, "all five commands accepted after repeated drains");
      } finally {
        poller.stop();
      }
    } finally {
      for (const client of clients) client.end();
    }
  });

  test("drain budget constant is sane", () => {
    expect(DEFAULT_DRAIN_MAX_PER_CYCLE).toBeGreaterThanOrEqual(10);
  });
});
