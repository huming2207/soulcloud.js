/**
 * Tests for the device status notification wiring (src/mqtt/status.ts):
 * online on connect, offline after a real disconnect, and — WEB-11 — no
 * false offline event when a same-clientId reconnect replaces the session
 * (aedes unregisters the old session before the replacement registers, so
 * suppression relies on the deferred-offline window).
 *
 * Requires: docker compose up -d postgres && bunx prisma migrate deploy
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashDevicePassword, prisma } from "@soulcloud/core";
import { MqttTestClient } from "../helpers/mqtt-client";
import { startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { attachDeviceStatusNotifications } from "../../src/mqtt/status";

const BROKER_PORT = 18885;
const BROKER_URL = `ws://127.0.0.1:${BROKER_PORT}/mqtt`;
const DEVICE_UID = `status-test-${randomUUID().slice(0, 8)}`;
const DEVICE_PASSWORD = "secret";

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

let broker: BrokerHandle;
let projectId: string;

// every status event, in order; tests snapshot the length as a baseline
const events: Array<[string, boolean]> = [];

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function connectDevice(): MqttTestClient {
  const client = new MqttTestClient(BROKER_URL, {
    clientId: DEVICE_UID,
    username: DEVICE_UID,
    password: DEVICE_PASSWORD,
  });
  void client.connect().catch(() => {});
  return client;
}

async function waitForConnect(client: MqttTestClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "status-test" } });
  await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: DEVICE_UID,
      assignedId: "status-test",
      passwordHash: await hashDevicePassword(DEVICE_PASSWORD),
      projectId,
    },
  });
  broker = await startBroker(prisma, { port: BROKER_PORT });
  attachDeviceStatusNotifications(broker.aedes, (uid, online) => {
    events.push([uid, online]);
  });
});

afterAll(async () => {
  await broker.close();
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("device status notifications", () => {
  test("emits online on connect and offline after a real disconnect", async () => {
    const baseline = events.length;
    const client = connectDevice();
    await waitForConnect(client);
    await waitFor(
      () => events.slice(baseline).some(([uid, online]) => uid === DEVICE_UID && online),
      "online event",
    );
    client.end();
    await waitFor(
      () => events.slice(baseline).some(([uid, online]) => uid === DEVICE_UID && !online),
      "offline event",
    );
  });

  test("a same-clientId reconnect does not emit a false offline event", async () => {
    // make sure the device is connected (and registered) first
    const baseline = events.length;
    const first = connectDevice();
    await waitForConnect(first);
    await waitFor(
      () => events.slice(baseline).some(([uid, online]) => uid === DEVICE_UID && online),
      "first online event",
    );

    // second connection with the same clientId replaces the first session
    const second = connectDevice();
    await waitForConnect(second);
    // the replacement closes the first session; wait for both the
    // disconnect and the second online event, then give the deferred
    // offline window time to (wrongly) fire
    await waitFor(
      () => events.slice(baseline).filter(([uid]) => uid === DEVICE_UID).length >= 2,
      "second online event",
    );
    await Bun.sleep(600); // > OFFLINE_DEFER_MS (300)

    const deviceEvents = events.slice(baseline).filter(([uid]) => uid === DEVICE_UID);
    const offline = deviceEvents.filter(([, online]) => !online);
    expect(offline).toEqual([]); // the replace must not look like offline

    // a real disconnect of the surviving session still reports offline
    second.end();
    await waitFor(
      () => events.slice(baseline).some(([uid, online]) => uid === DEVICE_UID && !online),
      "offline after real disconnect",
    );
  });
});
