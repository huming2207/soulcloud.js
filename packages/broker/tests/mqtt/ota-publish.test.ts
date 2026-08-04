/**
 * OTA delivery tests: the broker's ota poller publishes per-device
 * download notices (metadata + JWT) to online devices over the MQTT ota
 * topic; offline devices are deferred until their window expires.
 *
 * Requires: docker compose up -d postgres && db:deploy
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { decode } from "@msgpack/msgpack";
import {
  hashDevicePassword,
  prisma,
  signOtaToken,
  verifyOtaToken,
  createOtaJob,
} from "@soulcloud/core";
import { MqttTestClient } from "../helpers/mqtt-client";
import { startBroker, type BrokerHandle } from "../../src/mqtt/broker";
import { attachDispatch } from "../../src/mqtt/dispatch";
import { otaPollOnce } from "../../src/mqtt/ota-publish";

const BROKER_PORT = 18884;
const BROKER_URL = `ws://127.0.0.1:${BROKER_PORT}/mqtt`;
const SECRET = "ota-broker-test-secret-0123456789-0123456789";

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

let broker: BrokerHandle;
let projectId: string;
let releaseId: string;
let onlineDeviceUid: string;
let onlineDeviceId: string;
let offlineDeviceUid: string;
let offlineDeviceId: string;

async function createDevice(uid: string, project: string) {
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: uid,
      assignedId: `assigned-${uid}`,
      passwordHash: await hashDevicePassword("secret"),
      projectId: project,
    },
  });
  return device;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "ota-broker-test" } });
  const created = await prisma.firmwareRelease.create({
    data: {
      id: randomUUID(),
      projectId,
      binHash: "ab".repeat(32),
      binBytes: Buffer.from(new Uint8Array(64).fill(0xaa)),
      binSize: 64,
      version: "v2.0.0",
    },
  });
  releaseId = created.id;
  onlineDeviceUid = `ota-on-${randomUUID().slice(0, 8)}`;
  offlineDeviceUid = `ota-off-${randomUUID().slice(0, 8)}`;
  const online = await createDevice(onlineDeviceUid, projectId);
  const offline = await createDevice(offlineDeviceUid, projectId);
  onlineDeviceId = online.id;
  offlineDeviceId = offline.id;

  broker = await startBroker(prisma, { port: BROKER_PORT });
  attachDispatch(broker.aedes, prisma, silentLog);
});

afterAll(async () => {
  await broker.close();
  await prisma.otaTarget.deleteMany({ where: { job: { projectId } } });
  await prisma.otaJob.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({
    where: { id: { in: [onlineDeviceId, offlineDeviceId] } },
  });
  await prisma.firmwareRelease.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

async function waitFor<T>(
  predicate: () => Promise<T | null> | T | null,
  timeoutMs = 3000,
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("ota poller", () => {
  test("online device receives the ota notice with a valid per-device JWT", async () => {
    const client = new MqttTestClient(BROKER_URL, {
      clientId: onlineDeviceUid,
      username: onlineDeviceUid,
      password: "secret",
    });
    const notices: Array<Uint8Array> = [];
    client.on("message", (topic: string, payload: Uint8Array) => {
      notices.push(payload);
    });
    await client.connect();
    await client.subscribe(`soulcloud/v1/devices/${onlineDeviceUid}/ota`);

    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds: [onlineDeviceId],
      targetTtlSeconds: 900,
    });

    await waitFor(async () => {
      await otaPollOnce(broker.aedes, prisma, {
        secret: SECRET,
        pollIntervalMs: 500,
        leaseDurationMs: 60_000,
        tokenTtlSeconds: 900,
      }, silentLog);
      return notices.length > 0 ? true : null;
    });

    const notice = decode(notices[0]!) as Record<string, unknown>;
    expect(notice.release_id).toBe(releaseId);
    expect(notice.bin_sha256).toBe("ab".repeat(32));
    expect(notice.bin_size).toBe(64);
    expect(notice.version).toBe("v2.0.0");
    const download = notice.download as Record<string, unknown>;
    expect(download.url).toBe(`/v1/firmware-releases/${releaseId}/bin`);
    expect(typeof download.token).toBe("string");
    expect(typeof download.expires_at).toBe("string");
    // the token is bound to THIS device and THIS release
    const claims = await verifyOtaToken(SECRET, download.token as string);
    expect(claims).toEqual({ deviceUid: onlineDeviceUid, releaseId });
    // the signed token must be usable (round-trip through the same secret)
    const resigned = await signOtaToken(SECRET, claims!, 900);
    expect(resigned.split(".")[2]).toBe((download.token as string).split(".")[2]);

    // target is delivered
    const target = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(target?.state).toBe("delivered");
    expect(target?.deliveredAt).not.toBeNull();

    client.end();
  });

  test("offline device is deferred, not published", async () => {
    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds: [offlineDeviceId],
      targetTtlSeconds: 900,
    });
    // several poll cycles: nothing should be published (device offline)
    for (let i = 0; i < 3; i++) {
      await otaPollOnce(broker.aedes, prisma, {
        secret: SECRET,
        pollIntervalMs: 500,
        leaseDurationMs: 60_000,
        tokenTtlSeconds: 900,
      }, silentLog);
    }
    const target = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(target?.state).toBe("pending");
  });

  test("target past its delivery window expires and is never published", async () => {
    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds: [offlineDeviceId],
      targetTtlSeconds: 900,
    });
    await prisma.otaTarget.updateMany({
      where: { jobId: job.jobId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await otaPollOnce(broker.aedes, prisma, {
      secret: SECRET,
      pollIntervalMs: 500,
      leaseDurationMs: 60_000,
      tokenTtlSeconds: 900,
    }, silentLog);
    const target = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(target?.state).toBe("expired");
  });
});
