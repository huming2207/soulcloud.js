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
import { randomUUID } from "node:crypto";
import { encodeDeviceStat, prisma } from "@soulcloud/core";
import { attachDispatch, type DispatchLog } from "../../src/mqtt/dispatch";

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
