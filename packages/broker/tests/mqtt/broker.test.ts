import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { enqueueBatch, prisma } from "@soulcloud/core";
import { startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { attachDispatch } from "../../src/mqtt/dispatch";
import { pollOnce } from "../../src/mqtt/publish";
import {
  decodeDeviceCommandExecution,
  encodeDeviceCommandResult,
  encodeDeviceStat,
} from "@soulcloud/core";

// Integration tests for the embedded Aedes broker.
// Requires: docker compose up -d postgres && bunx prisma migrate deploy

const BROKER_PORT = 18883;
const DEVICE_UID = `mqtt-test-${randomUUID().slice(0, 8)}`;
const DEVICE_PASSWORD = "secret";

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

let broker: BrokerHandle;
let projectId: string;
let deviceId: string;

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "mqtt-test-project" },
  });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: DEVICE_UID,
      assignedId: "assigned-mqtt",
      passwordHash: DEVICE_PASSWORD, // plaintext until hashing is decided
      projectId,
    },
  });
  deviceId = device.id;

  broker = await startBroker(prisma, BROKER_PORT);
  attachDispatch(broker.aedes, prisma, silentLog);
});

afterAll(async () => {
  await broker.close();
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

// Each test starts with an empty command queue (previous tests may leave
// broker_accepted rows that would block new commands for the same device).
beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`;
});

function connectDevice(overrides: Record<string, unknown> = {}): MqttClient {
  return mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: DEVICE_PASSWORD,
    ...overrides,
  });
}

function waitForConnect(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

describe("device authentication", () => {
  test("rejects clientId that differs from username (impersonation)", async () => {
    // attacker holds device credentials but connects with another clientId
    const device = mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      clientId: "some-other-device",
      username: DEVICE_UID,
      password: DEVICE_PASSWORD,
    });
    const result = await new Promise<string>((resolve) => {
      device.once("connect", () => resolve("connected"));
      device.once("error", (err) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(result.startsWith("error")).toBe(true);
    device.end(true);
  });

  test("rejects clientId containing MQTT wildcards", async () => {
    const device = mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      clientId: "+",
      username: "+",
      password: DEVICE_PASSWORD,
    });
    const result = await new Promise<string>((resolve) => {
      device.once("connect", () => resolve("connected"));
      device.once("error", (err) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(result.startsWith("error")).toBe(true);
    device.end(true);
  });

  test("rejects clientId with topic separator", async () => {
    const device = mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      clientId: "dev/other",
      username: "dev/other",
      password: DEVICE_PASSWORD,
    });
    const result = await new Promise<string>((resolve) => {
      device.once("connect", () => resolve("connected"));
      device.once("error", (err) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(result.startsWith("error")).toBe(true);
    device.end(true);
  });

  test("accepts valid credentials", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    device.end(true);
  });

  test("rejects wrong password", async () => {
    const device = connectDevice({ password: "wrong" });
    const result = await new Promise<string>((resolve) => {
      device.once("connect", () => resolve("connected"));
      device.once("error", (err) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(result.startsWith("error")).toBe(true);
    device.end(true);
  });

  test("rejects unknown device UID", async () => {
    const device = mqtt.connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      clientId: "unknown-dev",
      username: "unknown-dev",
      password: "x",
    });
    const result = await new Promise<string>((resolve) => {
      device.once("connect", () => resolve("connected"));
      device.once("error", (err) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(result.startsWith("error")).toBe(true);
    device.end(true);
  });
});

describe("topic authorization", () => {
  test("device can subscribe to its own cmd/exec", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    const sub = await new Promise((resolve, reject) => {
      device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, { qos: 1 }, (err) =>
        err ? reject(err) : resolve(null),
      );
      setTimeout(() => reject(new Error("subscribe timeout")), 5000);
    });
    expect(sub).toBeNull();
    device.end(true);
  });

  test("device cannot subscribe to another device's topic", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    // authorizeSubscribe rejection disconnects the client
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await new Promise<void>((resolve) => {
      device.subscribe("soulcloud/v1/devices/other-dev/cmd/exec", { qos: 1 }, () =>
        resolve(),
      );
      setTimeout(resolve, 1000);
    });
    expect(await disconnected).toBe(true);
    device.end(true);
  });

  test("device cannot subscribe to its own uplink topics (no echo)", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await new Promise<void>((resolve) => {
      device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/log`, { qos: 1 }, () =>
        resolve(),
      );
      setTimeout(resolve, 1000);
    });
    expect(await disconnected).toBe(true);
    device.end(true);
  });

  test("device cannot publish to its own downlink topic", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await new Promise<void>((resolve) => {
      device.publish(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, Buffer.from("x"), { qos: 0 }, () => resolve());
      setTimeout(resolve, 1000);
    });
    expect(await disconnected).toBe(true);
    device.end(true);
  });
});

describe("command delivery loop", () => {
  test("polls and publishes a queued command to the device", async () => {
    const batch = await enqueueBatch(prisma, [deviceId], { cmd: "reboot" });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });

    const device = connectDevice();
    await waitForConnect(device);
    await new Promise<void>((resolve, reject) => {
      device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, { qos: 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
      setTimeout(() => reject(new Error("subscribe timeout")), 5000);
    });

    const received = new Promise<{ topic: string; payload: Buffer }>((resolve) => {
      device.once("message", (topic, payload) => resolve({ topic, payload }));
      setTimeout(() => resolve({ topic: "", payload: Buffer.alloc(0) }), 5000);
    });

    await pollOnce(broker.aedes, prisma, {
      pollIntervalMs: 100,
      leaseDurationMs: 60_000,
      retain: false,
    }, silentLog);

    const msg = await received;
    expect(msg.topic).toBe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);
    expect(msg.payload.length).toBeGreaterThan(0);

    // the published payload must decode as the same execution
    const decoded = decodeDeviceCommandExecution(msg.payload);
    expect(decoded.cmd).toBe("reboot");
    expect(decoded.seq).toBe(row.sequence);

    // the row must now be broker_accepted
    const updated = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(updated.state).toBe("broker_accepted");
    expect(updated.brokerAcceptedAt).not.toBeNull();

    device.end(true);
  });

  test("device result completes the command end-to-end", async () => {
    const batch = await enqueueBatch(prisma, [deviceId], {
      cmd: "getConfig",
      args: [{ key: "logging.level" }],
    });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });
    const decoded = decodeDeviceCommandExecution(row.payload);

    const device = connectDevice();
    await waitForConnect(device);

    const resultPacket = Buffer.from(
      encodeDeviceCommandResult({
        id: decoded.id,
        seq: decoded.seq,
        code: 0,
        payload: [{ "logging.level": 3 }],
      }),
    );

    await new Promise<void>((resolve, reject) => {
      device.publish(
        `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
        resultPacket,
        { qos: 1 },
        (err) => (err ? reject(err) : resolve()),
      );
      setTimeout(() => reject(new Error("publish timeout")), 5000);
    });

    // wait for the async dispatch to persist
    await new Promise((r) => setTimeout(r, 300));
    const completed = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(completed.state).toBe("device_completed");
    expect(completed.resultCode).toBe(0);
    expect(completed.resultPacket).toEqual(resultPacket);

    device.end(true);
  });

  test("full loop: enqueue -> publish -> device result -> completed", async () => {
    const batch = await enqueueBatch(prisma, [deviceId], { cmd: "setLogging", args: [{ enabled: true }] });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });

    const device = connectDevice();
    await waitForConnect(device);
    await new Promise<void>((resolve, reject) => {
      device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, { qos: 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
      setTimeout(() => reject(new Error("subscribe timeout")), 5000);
    });

    const received = new Promise<Buffer>((resolve) => {
      device.once("message", (_t, payload) => resolve(payload));
      setTimeout(() => resolve(Buffer.alloc(0)), 5000);
    });

    await pollOnce(broker.aedes, prisma, {
      pollIntervalMs: 100,
      leaseDurationMs: 60_000,
      retain: false,
    }, silentLog);

    const execPayload = await received;
    expect(execPayload.length).toBeGreaterThan(0);
    const exec = decodeDeviceCommandExecution(execPayload);

    // device responds with the terminal result
    const resultPacket = Buffer.from(
      encodeDeviceCommandResult({ id: exec.id, seq: exec.seq, code: 0 }),
    );
    await new Promise<void>((resolve, reject) => {
      device.publish(`soulcloud/v1/devices/${DEVICE_UID}/cmd/result`, resultPacket, { qos: 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
      setTimeout(() => reject(new Error("result publish timeout")), 5000);
    });

    await new Promise((r) => setTimeout(r, 300));
    const completed = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(completed.state).toBe("device_completed");
    expect(completed.resultCode).toBe(0);
    expect(completed.resultPacket).toEqual(resultPacket);

    device.end(true);
  });
});

describe("log/stat uplink ingestion", () => {
  test("device log packets are stored as raw events", async () => {
    // a minimal valid on9log LOG packet (streaming, no args)
    const packet = new Uint8Array([
      0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00,
    ]);
    const device = connectDevice();
    await waitForConnect(device);
    await new Promise<void>((resolve, reject) => {
      device.publish(`soulcloud/v1/devices/${DEVICE_UID}/log`, Buffer.from(packet), { qos: 1 }, (e) =>
        e ? reject(e) : resolve(),
      );
      setTimeout(() => reject(new Error("log publish timeout")), 5000);
    });
    await new Promise((r) => setTimeout(r, 300));

    const events = await prisma.rawLogEvent.findMany({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.packetType).toBe(0);
    expect(events[0]!.rawPacket).toEqual(Buffer.from(packet));
    expect(events[0]!.decodeState).toBe("unknown_fw"); // no firmware state yet

    // cleanup this test's events
    await prisma.rawLogEvent.deleteMany({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    device.end(true);
  });

  test("invalid log packets are dropped without storage", async () => {
    const before = await prisma.rawLogEvent.count({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    const device = connectDevice();
    await waitForConnect(device);
    await new Promise<void>((resolve) => {
      device.publish(`soulcloud/v1/devices/${DEVICE_UID}/log`, Buffer.from([0x00, 0x01]), { qos: 0 }, () =>
        resolve(),
      );
      setTimeout(resolve, 1000);
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.rawLogEvent.count({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(after).toBe(before);
    device.end(true);
  });

  test("stat updates the device firmware state", async () => {
    const fw = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const device = connectDevice();
    await waitForConnect(device);
    await new Promise<void>((resolve, reject) => {
      device.publish(
        `soulcloud/v1/devices/${DEVICE_UID}/stat`,
        Buffer.from(
          encodeDeviceStat({
            sn: new Uint8Array(4),
            fw,
            up: 5n,
            rst: "watchdog",
          }),
        ),
        { qos: 1 },
        (e) => (e ? reject(e) : resolve()),
      );
      setTimeout(() => reject(new Error("stat publish timeout")), 5000);
    });
    await new Promise((r) => setTimeout(r, 300));

    const state = await prisma.deviceFirmwareState.findFirstOrThrow({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(state.fwHash).toBe("aabbcc");

    // second stat updates the hash
    await new Promise<void>((resolve, reject) => {
      device.publish(
        `soulcloud/v1/devices/${DEVICE_UID}/stat`,
        Buffer.from(
          encodeDeviceStat({
            sn: new Uint8Array(4),
            fw: new Uint8Array([0x01]),
            up: 6n,
            rst: "power-on",
          }),
        ),
        { qos: 1 },
        (e) => (e ? reject(e) : resolve()),
      );
      setTimeout(() => reject(new Error("stat publish timeout")), 5000);
    });
    await new Promise((r) => setTimeout(r, 300));
    const updated = await prisma.deviceFirmwareState.findFirstOrThrow({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(updated.fwHash).toBe("01");

    await prisma.deviceFirmwareState.deleteMany({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    device.end(true);
  });
});

describe("M2: offline devices", () => {
  test("commands to offline devices stay queued (not published)", async () => {
    const batch = await enqueueBatch(prisma, [deviceId], { cmd: "reboot" });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });

    // no device connected under DEVICE_UID
    await pollOnce(broker.aedes, prisma, {
      pollIntervalMs: 100,
      leaseDurationMs: 60_000,
      retain: false,
      offlineRetryMs: 60_000,
    }, silentLog);

    const after = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.state).toBe("queued"); // not broker_accepted
    expect(after.leaseExpiresAt).toBeNull();
    // deferred: not claimable immediately
    expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
});
