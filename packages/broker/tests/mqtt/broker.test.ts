import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CREDENTIAL_REVOKED_CHANNEL,
  enqueueBatch,
  hashDevicePassword,
  prisma,
} from "@soulcloud/core";
import { MqttTestClient, type MqttTestClientOptions } from "../helpers/mqtt-client";
// Serialises this file against the other global-lease test files (queue,
// ota/deploy): pollOnce leases over a global FIFO shared across files on
// one dev database. Held for the whole process; the advisory lock dies
// with the connection (crash-safe).
import { acquireLeaseLock } from "../../../core/tests/helpers/lease-lock";
await acquireLeaseLock(prisma);
import { kickDeviceSession, startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { attachDispatch } from "../../src/mqtt/dispatch";
import { startNotifier, type Notifier } from "../../src/mqtt/notify";
import { pollOnce } from "../../src/mqtt/publish";
import {
  decodeDeviceCommandExecution,
  encodeDeviceCommandResult,
  encodeDeviceStat,
} from "@soulcloud/core";

// Integration tests for the embedded Aedes broker.
// Requires: docker compose up -d postgres && bunx prisma migrate deploy

const BROKER_PORT = 18883;
const BROKER_URL = `ws://127.0.0.1:${BROKER_PORT}/mqtt`;
const DEVICE_UID = `mqtt-test-${randomUUID().slice(0, 8)}`;
const DEVICE_PASSWORD = "secret";

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

let broker: BrokerHandle;
let notifier: Notifier;
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
      passwordHash: await hashDevicePassword(DEVICE_PASSWORD),
      projectId,
    },
  });
  deviceId = device.id;

  broker = await startBroker(prisma, { port: BROKER_PORT });
  attachDispatch(broker.aedes, prisma, silentLog);
  // production wiring: revocation notifications kill live sessions
  notifier = await startNotifier(
    process.env.DATABASE_URL!,
    {
      onCommand: () => {},
      onOta: () => {},
      onCredentialRevoked: (deviceUid) => {
        kickDeviceSession(broker.aedes, deviceUid);
      },
    },
    silentLog,
  );
});

afterAll(async () => {
  await notifier.close();
  await broker.close();
  await prisma.deviceCommand.deleteMany({
    where: { device: { deviceUid: DEVICE_UID } },
  });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

// Each test starts with an empty command queue for THIS test's device
// (previous tests may leave broker_accepted rows that would block new
// commands; scoping avoids touching other test files' rows).
beforeEach(async () => {
  await prisma.deviceCommand.deleteMany({
    where: { device: { deviceUid: DEVICE_UID } },
  });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
});

function connectDevice(overrides: Partial<MqttTestClientOptions> = {}): MqttTestClient {
  const client = new MqttTestClient(BROKER_URL, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: DEVICE_PASSWORD,
    ...overrides,
  });
  // the mini client needs an explicit connect() (unlike mqtt.js which
  // connects on construction); errors surface via the "error" event
  void client.connect().catch(() => {});
  return client;
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

function waitForConnect(client: MqttTestClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

/** Attempts a connection and returns the outcome string (connect/error/timeout). */
async function tryConnect(overrides: Partial<MqttTestClientOptions> = {}): Promise<string> {
  const client = connectDevice(overrides);
  return new Promise<string>((resolve) => {
    client.once("connect", () => resolve("connected"));
    client.once("error", (err: Error) => resolve(`error: ${err.message}`));
    setTimeout(() => resolve("timeout"), 5000);
  });
}

describe("device authentication", () => {
  test("rejects clientId that differs from username (impersonation)", async () => {
    // attacker holds device credentials but connects with another clientId
    const result = await tryConnect({ clientId: "some-other-device" });
    expect(result.startsWith("error")).toBe(true);
  });

  test("rejects clientId containing MQTT wildcards", async () => {
    const result = await tryConnect({ clientId: "+", username: "+" });
    expect(result.startsWith("error")).toBe(true);
  });

  test("rejects clientId with topic separator", async () => {
    const result = await tryConnect({ clientId: "dev/other", username: "dev/other" });
    expect(result.startsWith("error")).toBe(true);
  });

  test("accepts valid credentials", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    device.end();
  });

  test("rejects wrong password", async () => {
    const result = await tryConnect({ password: "wrong" });
    expect(result.startsWith("error")).toBe(true);
  });

  test("rejects unknown device UID", async () => {
    const result = await tryConnect({
      clientId: "unknown-dev",
      username: "unknown-dev",
      password: "x",
    });
    expect(result.startsWith("error")).toBe(true);
  });
});

describe("topic authorization", () => {
  test("device can subscribe to its own cmd/exec", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    await device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);
    device.end();
  });

  test("device cannot subscribe to another device's topic", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    // authorizeSubscribe rejection disconnects the client
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await device.subscribe("soulcloud/v1/devices/other-dev/cmd/exec").catch(() => {});
    expect(await disconnected).toBe(true);
    device.end();
  });

  test("device cannot subscribe to its own uplink topics (no echo)", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/log`).catch(() => {});
    expect(await disconnected).toBe(true);
    device.end();
  });

  test("device cannot publish to its own downlink topic", async () => {
    const device = connectDevice();
    await waitForConnect(device);
    const disconnected = new Promise<boolean>((resolve) => {
      device.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await device.publish(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`, Buffer.from("x"), 0);
    expect(await disconnected).toBe(true);
    device.end();
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
    await device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);

    const received = device.waitMessage(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);

    await pollOnce(broker.aedes, prisma, {
      pollIntervalMs: 100,
      leaseDurationMs: 60_000,
      retain: false,
    }, silentLog);

    const msg = await received.then((payload) => ({
      topic: `soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`,
      payload,
    }));
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

    device.end();
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

    await device.publish(
      `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
      resultPacket,
      1,
    );

    // wait for the async dispatch to persist
    await waitFor(
      async () => {
        const row2 = await prisma.deviceCommand.findUnique({ where: { id: row.id } });
        return row2?.state === "device_completed";
      },
      "result persisted",
    );
    const completed = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(completed.state).toBe("device_completed");
    expect(completed.resultCode).toBe(0);
    expect(completed.resultPacket).toEqual(resultPacket);

    device.end();
  });

  test("full loop: enqueue -> publish -> device result -> completed", async () => {
    const batch = await enqueueBatch(prisma, [deviceId], { cmd: "setLogging", args: [{ enabled: true }] });
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId: batch.id },
    });

    const device = connectDevice();
    await waitForConnect(device);
    await device.subscribe(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);

    const received = device.waitMessage(`soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`);

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
    await device.publish(
      `soulcloud/v1/devices/${DEVICE_UID}/cmd/result`,
      resultPacket,
      1,
    );
    await waitFor(
      async () => {
        const r = await prisma.deviceCommand.findUnique({ where: { id: row.id } });
        return r?.state === "device_completed";
      },
      "full loop completion",
    );
    const completed = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(completed.state).toBe("device_completed");
    expect(completed.resultCode).toBe(0);
    expect(completed.resultPacket).toEqual(resultPacket);

    device.end();
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
    await device.publish(`soulcloud/v1/devices/${DEVICE_UID}/log`, Buffer.from(packet), 1);
    await waitFor(
      async () =>
        (await prisma.rawLogEvent.count({ where: { device: { deviceUid: DEVICE_UID } } })) > 0,
      "log event persisted",
    );

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
    device.end();
  });

  test("invalid log packets are dropped without storage", async () => {
    const before = await prisma.rawLogEvent.count({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    const device = connectDevice();
    await waitForConnect(device);
    await device.publish(`soulcloud/v1/devices/${DEVICE_UID}/log`, Buffer.from([0x00, 0x01]), 0);
    // give dispatch a couple of poll cycles, then confirm nothing was stored
    await waitFor(
      async () => {
        const pending = await prisma.rawLogEvent.count({ where: { device: { deviceUid: DEVICE_UID } } });
        await new Promise((r) => setTimeout(r, 400));
        return (await prisma.rawLogEvent.count({ where: { device: { deviceUid: DEVICE_UID } } })) === pending;
      },
      "invalid packet not stored",
    );
    const after = await prisma.rawLogEvent.count({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(after).toBe(before);
    device.end();
  });

  test("stat updates the device firmware state", async () => {
    const fw = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const device = connectDevice();
    await waitForConnect(device);
    await device.publish(
      `soulcloud/v1/devices/${DEVICE_UID}/stat`,
      Buffer.from(
        encodeDeviceStat({
          sn: new Uint8Array(4),
          fw,
          up: 5n,
          rst: "watchdog",
        }),
      ),
      1,
    );
    await waitFor(
      async () => (await prisma.deviceFirmwareState.count({ where: { device: { deviceUid: DEVICE_UID } } })) > 0,
      "firmware state persisted",
    );

    const state = await prisma.deviceFirmwareState.findFirstOrThrow({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(state.fwHash).toBe("aabbcc");

    // second stat updates the hash
    await device.publish(
      `soulcloud/v1/devices/${DEVICE_UID}/stat`,
      Buffer.from(
        encodeDeviceStat({
          sn: new Uint8Array(4),
          fw: new Uint8Array([0x01]),
          up: 6n,
          rst: "power-on",
        }),
      ),
      1,
    );
    await waitFor(
      async () => {
        const s = await prisma.deviceFirmwareState.findFirst({ where: { device: { deviceUid: DEVICE_UID } } });
        return s?.fwHash === "01";
      },
      "firmware state updated",
    );
    const updated = await prisma.deviceFirmwareState.findFirstOrThrow({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    expect(updated.fwHash).toBe("01");

    await prisma.deviceFirmwareState.deleteMany({
      where: { device: { deviceUid: DEVICE_UID } },
    });
    device.end();
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

describe("WS-specific behavior", () => {
  test("unknown WS path returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${BROKER_PORT}/wrong-path`);
    expect(res.status).toBe(404);
  });

  test("MQTT path serves the WS upgrade", async () => {
    const res = await fetch(`http://127.0.0.1:${BROKER_PORT}/mqtt`, {
      headers: { connection: "upgrade", upgrade: "websocket" },
    });
    // no upgrade headers -> Bun responds 400/426; the point is the route exists
    expect([400, 426]).toContain(res.status);
  });

  test("device authenticates with a scrypt-hashed password", async () => {
    const uid = `scrypt-${randomUUID().slice(0, 8)}`;
    const { hashDevicePassword } = await import("@soulcloud/core");
    const hash = await hashDevicePassword("hashed-pw");
    await prisma.device.create({
      data: { id: randomUUID(), deviceUid: uid, assignedId: "scrypt", passwordHash: hash, projectId },
    });
    const client = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: "hashed-pw" });
    void client.connect().catch(() => {});
    await waitForConnect(client);
    client.end();
    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });
});

describe("G group: device credential revocation", () => {
  test("revoked devices are refused at CONNECT", async () => {
    // create a device, mark it revoked, attempt connection
    const uid = `revoked-${randomUUID().slice(0, 8)}`;
    const { hashDevicePassword } = await import("@soulcloud/core");
    const hash = await hashDevicePassword("pw-123");
    await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: "revoked",
        passwordHash: hash,
        authRevoked: true,
        projectId,
      },
    });
    const client = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: "pw-123" });
    void client.connect().catch(() => {});
    const outcome = await new Promise<string>((resolve) => {
      client.once("connect", () => resolve("connected"));
      client.once("error", (err: Error) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(outcome.startsWith("error")).toBe(true);
    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });

  test("re-issued credentials connect again", async () => {
    const uid = `reissue-${randomUUID().slice(0, 8)}`;
    const { hashDevicePassword } = await import("@soulcloud/core");
    const hash = await hashDevicePassword("pw-123");
    await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: "reissue",
        passwordHash: hash,
        authRevoked: true,
        projectId,
      },
    });
    // revoke cleared by re-issue (new hash)
    const newHash = await hashDevicePassword("pw-new");
    await prisma.device.update({
      where: { deviceUid: uid },
      data: { passwordHash: newHash, authRevoked: false },
    });
    const client = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: "pw-new" });
    void client.connect().catch(() => {});
    await waitForConnect(client);
    client.end();
    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });
});


describe("G group: credential revocation kills live sessions", () => {
  test("a connected device is disconnected when its credentials are revoked", async () => {
    const { startNotifier } = await import("../../src/mqtt/notify");
    const uid = `kill-${randomUUID().slice(0, 8)}`;
    await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: "kill",
        passwordHash: await hashDevicePassword("pw-123"),
        projectId,
      },
    });

    // connect a real device over WS
    const client = new MqttTestClient(BROKER_URL, {
      clientId: uid,
      username: uid,
      password: "pw-123",
    });
    void client.connect().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    // listen for the revocation notification
    const revoked: string[] = [];
    const notifier = await startNotifier(
      process.env.DATABASE_URL!,
      { onCommand: () => {}, onOta: () => {}, onCredentialRevoked: (d) => revoked.push(d) },
      silentLog,
    );
    // deterministic LISTEN-ready check: probe the channel (replaces a
    // fixed sleep, which raced pg_notify delivery and made this flaky)
    await prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, 'probe')`;
    await waitFor(async () => revoked.includes("probe"), "notifier listening");

    // revoke via the database + notify (the API endpoint does exactly this)
    await prisma.$transaction([
      prisma.device.update({ where: { deviceUid: uid }, data: { authRevoked: true } }),
      prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, ${uid})`,
    ]);

    // the live session must be killed
    const disconnected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      client.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(disconnected).toBe(true);
    expect(revoked).toContain(uid);

    await notifier.close();
    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });
});

describe("G group: credential rotation", () => {
  test("re-issuing credentials invalidates the old password", async () => {
    const { generateDevicePassword } = await import("@soulcloud/core");
    const uid = `rotate-${randomUUID().slice(0, 8)}`;
    const oldPw = generateDevicePassword();
    await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: "rotate",
        passwordHash: await hashDevicePassword(oldPw),
        projectId,
      },
    });

    // old password connects
    const c1 = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: oldPw });
    void c1.connect().catch(() => {});
    await waitForConnect(c1);
    c1.end();

    // re-issue (as the API endpoint does: new hash replaces the old one)
    const newPw = generateDevicePassword();
    await prisma.device.update({
      where: { deviceUid: uid },
      data: { passwordHash: await hashDevicePassword(newPw), authRevoked: false },
    });

    // old password is now refused
    const c2 = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: oldPw });
    void c2.connect().catch(() => {});
    const oldOutcome = await new Promise<string>((resolve) => {
      c2.once("connect", () => resolve("connected"));
      c2.once("error", (err: Error) => resolve(`error: ${err.message}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    expect(oldOutcome.startsWith("error")).toBe(true);

    // new password connects
    const c3 = new MqttTestClient(BROKER_URL, { clientId: uid, username: uid, password: newPw });
    void c3.connect().catch(() => {});
    await waitForConnect(c3);
    c3.end();

    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });
});

describe("G group: kickDeviceSession", () => {
  test("credential rotation kicks the live session (same path as revoke)", async () => {
    const { startNotifier } = await import("../../src/mqtt/notify");
    const uid = `rotate-${randomUUID().slice(0, 8)}`;
    await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: uid,
        assignedId: "rotate",
        passwordHash: await hashDevicePassword("pw-old"),
        projectId,
      },
    });

    const client = new MqttTestClient(BROKER_URL, {
      clientId: uid,
      username: uid,
      password: "pw-old",
    });
    void client.connect().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });

    // rotation = new hash + revocation notify (exactly what the API
    // credentials endpoint does, see logging.ts)
    const kicked: string[] = [];
    const notifier = await startNotifier(
      process.env.DATABASE_URL!,
      { onCommand: () => {}, onOta: () => {}, onCredentialRevoked: (d) => kicked.push(d) },
      silentLog,
    );
    await prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, 'probe')`;
    await waitFor(async () => kicked.includes("probe"), "notifier listening");
    await prisma.$transaction([
      prisma.device.update({
        where: { deviceUid: uid },
        data: { passwordHash: await hashDevicePassword("pw-new"), authRevoked: false },
      }),
      prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, ${uid})`,
    ]);

    const disconnected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      client.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(disconnected).toBe(true);
    expect(kicked).toContain(uid);

    await notifier.close();
    await prisma.device.deleteMany({ where: { deviceUid: uid } });
  });

  test("returns false for devices that are not connected", () => {
    const kicked = kickDeviceSession(broker.aedes, "not-connected-device");
    expect(kicked).toBe(false);
  });
});
