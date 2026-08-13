/**
 * Dispatch guards + uplink handler tests (Kimi round-7 P0-1): the
 * maxPacketBytes and per-device rate limits were never exercised — broker
 * tests start dispatch without guards. This file drives the aedes
 * "publish" event directly (no real broker or port needed) and asserts
 * the drop/process decisions end to end, including the stat firmware
 * state persistence path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { createHash, randomUUID } from "node:crypto";
import { encodeDeviceStat, prisma } from "@soulcloud/core";
import { msgpackLogBundle, validLogPacket } from "../helpers/mqtt-client";
import { attachDispatch, type DispatchLog, UplinkWorkQueue } from "../../src/mqtt/dispatch";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";
import { createFirmwareRelease } from "../../../core/src/ota/release";
import {
  createOtaJob,
  leaseNextOtaTarget,
  markOtaTargetDelivered,
} from "../../../core/src/ota/deploy";
// Serialises this file against the other ota_targets leasing files
// (deploy, broker): ota_targets leasing is a global FIFO over a shared
// dev database. Held for the whole process; the advisory lock dies with
// the connection (crash-safe).
import { acquireLeaseLock } from "../../../core/tests/helpers/lease-lock";
await acquireLeaseLock(prisma);

let projectId: string;
let deviceId: string;
const deviceUid = `dispatch-${randomUUID().slice(0, 8)}`;

interface Logged {
  level: "info" | "warn" | "debug";
  msg: string;
}

function makeLog(): DispatchLog & { entries: Logged[] } {
  const entries: Logged[] = [];
  const rec = (level: Logged["level"]) => (msg: string) => {
    entries.push({ level, msg });
  };
  return { info: rec("info"), warn: rec("warn"), debug: rec("debug"), entries };
}

function validStat(): Uint8Array {
  return encodeDeviceStat({
    sn: new Uint8Array([1, 2, 3]),
    fw: new Uint8Array(32),
    up: 123n,
    rst: "power-on",
  });
}

/** Emits an uplink publish as a device client would. */
function emitUplink(
  aedes: Aedes,
  uid: string,
  topic: string,
  payload: Uint8Array | string,
): void {
  aedes.emit("publish", {
    topic,
    payload: typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload),
  }, { id: uid } as never);
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

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "dispatch-test" } });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-dispatch",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
  await prisma.device.delete({ where: { id: deviceId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("attachDispatch guards", () => {
  test("global work queue is bounded and serializes each device", async () => {
    const queue = new UplinkWorkQueue(2, 3, 1024);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    expect(queue.enqueue({
      deviceUid: "device-a",
      byteSize: 1,
      run: async () => {
        order.push("a1-start");
        await firstBlocked;
        order.push("a1-end");
      },
    })).toBe(true);
    expect(queue.enqueue({
      deviceUid: "device-a",
      byteSize: 1,
      run: async () => { order.push("a2"); },
    })).toBe(true);
    expect(queue.enqueue({
      deviceUid: "device-b",
      byteSize: 1,
      run: async () => { order.push("b1"); },
    })).toBe(true);
    expect(queue.enqueue({
      deviceUid: "device-c",
      byteSize: 1,
      run: async () => { order.push("c1"); },
    })).toBe(false);

    await Bun.sleep(5);
    expect(order).toEqual(["a1-start", "b1"]);
    releaseFirst();
    await Bun.sleep(5);
    expect(order).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });

  test("the byte budget rejects work that would exceed it", async () => {
    const queue = new UplinkWorkQueue(1, 100, 100);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    expect(
      queue.enqueue({
        deviceUid: "device-a",
        byteSize: 80,
        run: async () => {
          await firstBlocked;
        },
      }),
    ).toBe(true);
    // 80 + 30 > 100: rejected even though the count limit would allow it
    expect(
      queue.enqueue({
        deviceUid: "device-b",
        byteSize: 30,
        run: async () => {},
      }),
    ).toBe(false);
    // 80 + 20 <= 100: accepted
    expect(
      queue.enqueue({
        deviceUid: "device-c",
        byteSize: 20,
        run: async () => {},
      }),
    ).toBe(true);
    // the budget frees up when work completes
    releaseFirst();
    await Bun.sleep(5);
    expect(
      queue.enqueue({
        deviceUid: "device-d",
        byteSize: 100,
        run: async () => {},
      }),
    ).toBe(true);
  });

  test("drops oversized uplink packets before any handling", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log, {
      maxPacketBytes: 10,
      ratePerSecond: 100,
      rateBurst: 100,
    });
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, "x".repeat(20));
    expect(log.entries.some((e) => e.msg === "dropped oversized uplink packet")).toBe(true);
    // nothing else happened (no stat processing, no invalid-status warn)
    expect(log.entries.filter((e) => e.level !== "warn")).toHaveLength(0);
  });

  test("drops packets over the per-device rate limit", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log, {
      maxPacketBytes: 1024,
      ratePerSecond: 0.001, // refills ~never
      rateBurst: 1,
    });
    const stat = validStat();
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, stat);
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, stat);
    expect(log.entries.some((e) => e.msg === "dropped uplink packet over rate limit")).toBe(
      true,
    );
  });

  test("a log bundle costs one rate-limit token per element (WEB-03)", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log, {
      maxPacketBytes: 65536,
      ratePerSecond: 0.001, // refills ~never
      rateBurst: 2,
    });
    const logTopic = `soulcloud/v1/devices/${deviceUid}/log`;

    // a 3-element bundle needs 3 tokens and must be refused at burst 2
    const big = msgpackLogBundle(validLogPacket(), validLogPacket(), validLogPacket());
    emitUplink(aedes, deviceUid, logTopic, new Uint8Array([0x01, ...big]));
    expect(log.entries.some((e) => e.msg === "dropped uplink packet over rate limit")).toBe(
      true,
    );

    // a 2-element bundle fits the burst: it is ingested
    const log2 = makeLog();
    const aedes2 = new Aedes();
    attachDispatch(aedes2, prisma, log2, {
      maxPacketBytes: 65536,
      ratePerSecond: 0.001,
      rateBurst: 2,
    });
    const fit = msgpackLogBundle(validLogPacket(), validLogPacket());
    emitUplink(aedes2, deviceUid, logTopic, new Uint8Array([0x01, ...fit]));
    await waitFor(
      async () => (await prisma.rawLogEvent.count({ where: { deviceId } })) >= 2,
      "two-element bundle stored",
    );
    expect(
      log2.entries.some((e) => e.msg === "dropped uplink packet over rate limit"),
    ).toBe(false);

    // a single raw packet still costs one token and fits burst 1
    const log3 = makeLog();
    const aedes3 = new Aedes();
    attachDispatch(aedes3, prisma, log3, {
      maxPacketBytes: 65536,
      ratePerSecond: 0.001,
      rateBurst: 1,
    });
    emitUplink(aedes3, deviceUid, logTopic, validLogPacket());
    await waitFor(
      async () => (await prisma.rawLogEvent.count({ where: { deviceId } })) >= 3,
      "raw packet stored under burst 1",
    );
    expect(
      log3.entries.some((e) => e.msg === "dropped uplink packet over rate limit"),
    ).toBe(false);

    await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  });

  test("without guards, oversized packets reach the handler", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    // >10 bytes and NOT a valid stat: proves the handler ran (it would
    // have been dropped by guards otherwise) and validation failed loudly
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, "x".repeat(20));
    expect(log.entries.some((e) => e.msg === "ignored invalid device status")).toBe(true);
  });

  test("server-side publishes (no client) are ignored", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    aedes.emit("publish", { topic: `soulcloud/v1/devices/${deviceUid}/stat`, payload: validStat() });
    expect(log.entries).toHaveLength(0);
  });

  test("unknown topics and cross-device topics are dropped", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    emitUplink(aedes, deviceUid, "soulcloud/v1/devices/other/stat", validStat());
    expect(log.entries.some((e) => e.msg === "ignored topic for another device")).toBe(true);

    const log2 = makeLog();
    const aedes2 = new Aedes();
    attachDispatch(aedes2, prisma, log2);
    emitUplink(aedes2, deviceUid, "soulcloud/v1/devices/other/whatever", validStat());
    expect(log2.entries.some((e) => e.msg === "ignored unexpected topic")).toBe(true);
  });
});

describe("handleStat", () => {
  test("valid stat upserts the firmware state", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log, {
      maxPacketBytes: 1024,
      ratePerSecond: 100,
      rateBurst: 100,
    });
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, validStat());
    // poll instead of a fixed sleep: the upsert runs several async DB
    // round-trips that can lag past a sleep window under full-suite
    // parallel load (observed flake at 273ms with a 100ms sleep)
    await waitFor(async () => {
      const s = await prisma.deviceFirmwareState.findUnique({ where: { deviceId } });
      return s !== null && log.entries.some((e) => e.msg === "recorded device firmware state");
    }, "firmware state upsert and log entry");
    const state = await prisma.deviceFirmwareState.findUnique({ where: { deviceId } });
    expect(state?.fwHash).toBe("00".repeat(32));
  });

  test("invalid stat payload is rejected", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/stat`, "not-msgpack");
    expect(log.entries.some((e) => e.msg === "ignored invalid device status")).toBe(true);
  });

  test("stat from an unknown device is ignored", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    const ghostUid = `ghost-${randomUUID().slice(0, 8)}`;
    emitUplink(aedes, ghostUid, `soulcloud/v1/devices/${ghostUid}/stat`, validStat());
    // poll instead of a fixed sleep: the ignore decision follows an async
    // device lookup that can lag under full-suite parallel load
    await waitFor(
      async () => log.entries.some((e) => e.msg === "ignored stat from unknown device"),
      "ignored stat from unknown device",
    );
  });

  test("stat confirms an OTA target without a firmware change (redeploy path)", async () => {
    const elf = buildNoloadElf(["v=%d"], ["t"], 32, true);
    const buildId = createHash("sha256").update(elf).digest("hex");
    const rel = await createFirmwareRelease(prisma, {
      projectId,
      bin: new Uint8Array([1, 2, 3, 4]),
      elf,
    });
    try {
      const job = await createOtaJob(prisma, {
        projectId,
        releaseId: rel.releaseId,
        createdBy: randomUUID(),
        deviceIds: [deviceId],
        targetTtlSeconds: 900,
      });
      const target = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      await leaseNextOtaTarget(prisma, 60_000);
      await markOtaTargetDelivered(prisma, target!.id);
      // the device already reported this firmware BEFORE the job existed
      // (redeploy of the currently running release): the notice is
      // ignored by the device and the next stat reports the SAME hash.
      await prisma.deviceFirmwareState.upsert({
        where: { deviceId },
        update: { fwHash: buildId, reportedAt: new Date() },
        create: { deviceId, fwHash: buildId },
      });
      const log = makeLog();
      const aedes = new Aedes();
      attachDispatch(aedes, prisma, log, {
        maxPacketBytes: 1024,
        ratePerSecond: 100,
        rateBurst: 100,
      });
      emitUplink(
        aedes,
        deviceUid,
        `soulcloud/v1/devices/${deviceUid}/stat`,
        encodeDeviceStat({
          sn: new Uint8Array([1, 2, 3]),
          fw: Buffer.from(buildId, "hex"),
          up: 1n,
          rst: "power-on",
        }),
      );
      await waitFor(async () => {
        const t = await prisma.otaTarget.findUnique({ where: { id: target!.id } });
        return t?.state === "completed";
      }, "target confirmed by same-hash stat");
      // the confirm log is emitted by the same async path that completed
      // the target, so it must be present once the state is authoritative
      expect(log.entries).toContainEqual(
        expect.objectContaining({ msg: "ota target confirmed by firmware state" }),
      );
    } finally {
      const jobs = await prisma.otaJob.findMany({
        where: { releaseId: rel.releaseId },
        select: { id: true },
      });
      await prisma.otaTarget.deleteMany({ where: { jobId: { in: jobs.map((j) => j.id) } } });
      await prisma.otaJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
      if (rel.artifactId) {
        await prisma.firmwareArtifact.delete({ where: { id: rel.artifactId } });
      }
      await prisma.firmwareRelease.delete({ where: { id: rel.releaseId } });
      await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
    }
  });
});

describe("other uplink kinds", () => {
  test("invalid cmd/result payload is dropped", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/cmd/result`, "junk");
    expect(log.entries.some((e) => e.msg === "ignored invalid device command result")).toBe(
      true,
    );
  });

  test("log from an unknown device is dropped", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    const ghostUid = `ghost-${randomUUID().slice(0, 8)}`;
    emitUplink(aedes, ghostUid, `soulcloud/v1/devices/${ghostUid}/log`, "x");
    // poll instead of a fixed sleep: the ignore decision follows an async
    // device lookup that can lag under full-suite parallel load
    await waitFor(
      async () => log.entries.some((e) => e.msg === "ignored log from unknown device"),
      "ignored log from unknown device",
    );
  });
});

describe("handleLog log container", () => {
  test("a MsgPack bundle stores every valid element", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    const bundle = msgpackLogBundle(validLogPacket(), validLogPacket(), validLogPacket());
    emitUplink(
      aedes,
      deviceUid,
      `soulcloud/v1/devices/${deviceUid}/log`,
      new Uint8Array([0x01, ...bundle]),
    );
    await waitFor(
      async () => (await prisma.rawLogEvent.count({ where: { deviceId } })) >= 3,
      "three bundle elements stored",
    );
    const events = await prisma.rawLogEvent.findMany({ where: { deviceId } });
    expect(events.length).toBe(3);
    for (const e of events) expect(e.packetType).toBe(0);
    await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  });

  test("one bad element drops only itself", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    const bundle = msgpackLogBundle(
      validLogPacket(),
      new Uint8Array([0x00, 0x01]),
      validLogPacket(),
    );
    emitUplink(
      aedes,
      deviceUid,
      `soulcloud/v1/devices/${deviceUid}/log`,
      new Uint8Array([0x01, ...bundle]),
    );
    await waitFor(
      async () => (await prisma.rawLogEvent.count({ where: { deviceId } })) >= 2,
      "two valid elements stored",
    );
    const events = await prisma.rawLogEvent.findMany({ where: { deviceId } });
    expect(events.length).toBe(2);
    await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  });

  test("an unknown container magic is dropped with a warning", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    emitUplink(
      aedes,
      deviceUid,
      `soulcloud/v1/devices/${deviceUid}/log`,
      new Uint8Array([0x02, ...validLogPacket()]),
    );
    await waitFor(
      async () => log.entries.some((e) => e.msg === "ignored device log packet"),
      "unknown container magic warned",
    );
    const count = await prisma.rawLogEvent.count({ where: { deviceId } });
    expect(count).toBe(0);
  });

  test("raw single packets still store one event each", async () => {
    const log = makeLog();
    const aedes = new Aedes();
    attachDispatch(aedes, prisma, log);
    emitUplink(aedes, deviceUid, `soulcloud/v1/devices/${deviceUid}/log`, validLogPacket());
    await waitFor(
      async () => (await prisma.rawLogEvent.count({ where: { deviceId } })) >= 1,
      "raw packet stored",
    );
    const events = await prisma.rawLogEvent.findMany({ where: { deviceId } });
    expect(events.length).toBe(1);
    expect(events[0]!.packetType).toBe(0);
    expect(events[0]!.rawPacket).toEqual(Buffer.from(validLogPacket()));
    await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  });
});
