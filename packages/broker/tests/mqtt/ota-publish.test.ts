/**
 * OTA delivery tests: the broker's ota poller publishes per-device
 * download notices (metadata + JWT) to online devices over the MQTT ota
 * topic; offline devices are deferred until their window expires.
 *
 * Requires: docker compose up -d postgres && db:deploy
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import {
  encodeDeviceStat,
  hashDevicePassword,
  importArtifact,
  prisma,
  signOtaToken,
  verifyOtaToken,
  createOtaJob,
} from "@soulcloud/core";
import { MqttTestClient } from "../helpers/mqtt-client";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";
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
  await prisma.firmwareLogString.deleteMany({ where: { artifact: { projectId } } });
  await prisma.firmwareArtifact.deleteMany({ where: { projectId } });
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
                stallTimeoutMinutes: 30,
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
    expect(claims).toEqual({ deviceUid: onlineDeviceUid, releaseId, jobId: job.jobId });
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
                stallTimeoutMinutes: 30,
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
            stallTimeoutMinutes: 30,
    }, silentLog);
    const target = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(target?.state).toBe("expired");
  });
});

describe("ota result acknowledgements over MQTT", () => {
  test("device ack drives delivered -> downloaded -> installed", async () => {
    const client = new MqttTestClient(BROKER_URL, {
      clientId: onlineDeviceUid,
      username: onlineDeviceUid,
      password: "secret",
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

    // deliver the notice
    await waitFor(async () => {
      await otaPollOnce(broker.aedes, prisma, {
        secret: SECRET, pollIntervalMs: 500, leaseDurationMs: 60_000, tokenTtlSeconds: 900,
            stallTimeoutMinutes: 30,
      }, silentLog);
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "delivered" ? true : null;
    });

    // device acks downloaded
    await client.publish(`soulcloud/v1/devices/${onlineDeviceUid}/ota/result`,
      encode({ release_id: releaseId, job_id: job.jobId, state: "downloaded", code: 0 }));
    await waitFor(async () => {
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "downloaded" ? true : null;
    });

    // device acks installed
    await client.publish(`soulcloud/v1/devices/${onlineDeviceUid}/ota/result`,
      encode({ release_id: releaseId, job_id: job.jobId, state: "installed", code: 0 }));
    await waitFor(async () => {
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "installed" ? true : null;
    });
    // replay of the downloaded ack is ignored (state machine strictness)
    await client.publish(`soulcloud/v1/devices/${onlineDeviceUid}/ota/result`,
      encode({ release_id: releaseId, job_id: job.jobId, state: "downloaded", code: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(t?.state).toBe("installed");
    expect(t?.confirmedAt).toBeNull(); // awaiting run confirmation

    await client.end();
  });

  test("failed ack with a code lands in failed", async () => {
    const client = new MqttTestClient(BROKER_URL, {
      clientId: onlineDeviceUid,
      username: onlineDeviceUid,
      password: "secret",
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
        secret: SECRET, pollIntervalMs: 500, leaseDurationMs: 60_000, tokenTtlSeconds: 900,
            stallTimeoutMinutes: 30,
      }, silentLog);
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "delivered" ? true : null;
    });
    await client.publish(`soulcloud/v1/devices/${onlineDeviceUid}/ota/result`,
      encode({ release_id: releaseId, job_id: job.jobId, state: "failed", code: -2, message: "sha256 mismatch" }));
    await waitFor(async () => {
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "failed" ? true : null;
    });
    const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(t?.resultCode).toBe(-2);
    expect(t?.resultMessage).toBe("sha256 mismatch");
    expect(t?.confirmedAt).not.toBeNull();
    await client.end();
  });

  test("stat.fw change matching the release confirms completed (fact layer)", async () => {
    // releaseId fixture has no artifact -> use a release WITH an ELF
    const elf = buildNoloadElf(["value=%d"], ["demo"], 32, true);
    const elfHash = createHash("sha256").update(elf).digest("hex");
    const rel = await prisma.firmwareRelease.create({
      data: {
        id: randomUUID(),
        projectId,
        binHash: "cd".repeat(32),
        binBytes: Buffer.from(new Uint8Array(16).fill(0xcc)),
        binSize: 16,
        version: "v3.0.0",
      },
    });
    const artifact = await importArtifact(prisma, { projectId, elf });
    await prisma.firmwareRelease.update({
      where: { id: rel.id },
      data: { artifactId: artifact.artifactId },
    });

    const client = new MqttTestClient(BROKER_URL, {
      clientId: onlineDeviceUid,
      username: onlineDeviceUid,
      password: "secret",
    });
    await client.connect();
    await client.subscribe(`soulcloud/v1/devices/${onlineDeviceUid}/ota`);

    const job = await createOtaJob(prisma, {
      projectId,
      releaseId: rel.id,
      createdBy: randomUUID(),
      deviceIds: [onlineDeviceId],
      targetTtlSeconds: 900,
    });
    await waitFor(async () => {
      await otaPollOnce(broker.aedes, prisma, {
        secret: SECRET, pollIntervalMs: 500, leaseDurationMs: 60_000, tokenTtlSeconds: 900,
            stallTimeoutMinutes: 30,
      }, silentLog);
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "delivered" ? true : null;
    });

    // device boots the new firmware and reports it in stat
    await client.publish(`soulcloud/v1/devices/${onlineDeviceUid}/stat`,
      encodeDeviceStat({
        sn: new Uint8Array([1, 2, 3]),
        fw: Buffer.from(elfHash, "hex"),
        up: 42n,
        rst: "power-on",
      }));
    await waitFor(async () => {
      const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      return t?.state === "completed" ? true : null;
    });
    const t = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(t?.resultCode).toBe(0);
    expect(t?.confirmedAt).not.toBeNull();
    await client.end();
  });

  test("device cannot publish ota/result for another device", async () => {
    const client = new MqttTestClient(BROKER_URL, {
      clientId: onlineDeviceUid,
      username: onlineDeviceUid,
      password: "secret",
    });
    await client.connect();
    const disconnected = new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await client.publish(`soulcloud/v1/devices/someone-else/ota/result`,
      encode({ release_id: releaseId, job_id: randomUUID(), state: "failed", code: -1 })).catch(() => {});
    expect(await disconnected).toBe(true);
    client.end();
  });
});

describe("ota notice payload shape", () => {
  test("a release without version omits the version field", async () => {
    // fixture releaseId HAS version v2.0.0; create a plain one
    const rel = await prisma.firmwareRelease.create({
      data: {
        id: randomUUID(),
        projectId,
        binHash: "ef".repeat(32),
        binBytes: Buffer.from(new Uint8Array(8).fill(0xee)),
        binSize: 8,
      },
    });
    const dev = await createDevice(`ota-nov-${randomUUID().slice(0, 8)}`, projectId);
    let jobId = "";
    try {
      const job = await createOtaJob(prisma, {
        projectId,
        releaseId: rel.id,
        createdBy: randomUUID(),
        deviceIds: [dev.id],
        targetTtlSeconds: 900,
      });
      jobId = job.jobId;
      const client = new MqttTestClient(BROKER_URL, {
        clientId: dev.deviceUid,
        username: dev.deviceUid,
        password: "secret",
      });
      const notices: Array<Uint8Array> = [];
      client.on("message", (topic: string, payload: Uint8Array) => notices.push(payload));
      await client.connect();
      await client.subscribe(`soulcloud/v1/devices/${dev.deviceUid}/ota`);
      await waitFor(async () => {
        await otaPollOnce(broker.aedes, prisma, {
          secret: SECRET, pollIntervalMs: 500, leaseDurationMs: 60_000,
          tokenTtlSeconds: 900, stallTimeoutMinutes: 30,
        }, silentLog);
        return notices.length > 0 ? true : null;
      });
      const notice = decode(notices[0]!) as Record<string, unknown>;
      expect(notice.release_id).toBe(rel.id);
      expect(notice.version).toBeUndefined();
      expect(notice.job_id).toBe(jobId);
      await client.end();
    } finally {
      // FK order: targets -> jobs -> device -> release
      await prisma.otaTarget.deleteMany({ where: { jobId } });
      await prisma.otaJob.deleteMany({ where: { id: jobId } });
      await prisma.device.delete({ where: { id: dev.id } });
      await prisma.firmwareRelease.delete({ where: { id: rel.id } });
    }
  });
});
