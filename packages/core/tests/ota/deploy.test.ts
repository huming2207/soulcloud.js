/**
 * OTA deployment tests: per-device download JWTs (sign/verify, expiry,
 * tamper), job creation (explicit targets, project scoping), and the
 * target state machine (pending → leased → delivered / expired).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  MAX_OTA_TARGETS,
  OtaError,
  createOtaJob,
  expireOtaTargets,
  leaseNextOtaTarget,
  markOtaTargetDelivered,
  releaseOtaTarget,
  signOtaToken,
  verifyOtaToken,
} from "../../src/ota/deploy";
import { buildNoloadElf } from "../helpers/elf-builder";
import { createFirmwareRelease } from "../../src/ota/release";

const SECRET = "ota-test-secret-0123456789-0123456789-0123456789";

let projectId: string;
let otherProjectId: string;
let releaseId: string;
let deviceIds: string[];
let deviceUid: string;

const elf = buildNoloadElf(["value=%d"], ["demo"], 32, true);

beforeAll(async () => {
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "ota-deploy-test" } });
  await prisma.project.create({ data: { id: otherProjectId, name: "ota-deploy-other" } });

  const created = await createFirmwareRelease(prisma, {
    projectId,
    bin: new Uint8Array([1, 2, 3, 4]),
    elf,
  });
  releaseId = created.releaseId;

  deviceUid = `ota-dev-${randomUUID().slice(0, 8)}`;
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-ota-deploy",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceIds = [device.id];
});

afterAll(async () => {
  await prisma.otaTarget.deleteMany({ where: { job: { projectId } } });
  await prisma.otaJob.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
  await prisma.firmwareRelease.deleteMany({ where: { projectId } });
  await prisma.firmwareArtifact.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.$disconnect();
});

describe("OTA download JWT", () => {
  test("sign + verify round trip", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId }, 900);
    const claims = await verifyOtaToken(SECRET, token);
    expect(claims).toEqual({ deviceUid, releaseId });
  });

  test("expired token is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId }, -1);
    expect(await verifyOtaToken(SECRET, token)).toBeNull();
  });

  test("tampered token is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId }, 900);
    const [h, p, sig] = token.split(".");
    const tampered = `${h}.${p}.${sig === "x" ? "y" : "x"}`;
    expect(await verifyOtaToken(SECRET, tampered)).toBeNull();
  });

  test("wrong secret is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId }, 900);
    expect(await verifyOtaToken("different-secret-0123456789-0123456789", token)).toBeNull();
  });

  test("garbage is rejected", async () => {
    expect(await verifyOtaToken(SECRET, "not-a-jwt")).toBeNull();
  });
});

describe("createOtaJob", () => {
  test("creates a job with pending targets and notifies", async () => {
    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds,
      targetTtlSeconds: 900,
    });
    expect(job.jobId).toBeTruthy();
    expect(job.targets).toHaveLength(1);
    expect(job.targets[0]).toMatchObject({ deviceId: deviceIds[0]!, deviceUid, state: "pending" });
    const row = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    expect(row?.state).toBe("pending");
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("empty / duplicate / too-many targets are rejected", async () => {
    await expect(
      createOtaJob(prisma, { projectId, releaseId, createdBy: randomUUID(), deviceIds: [], targetTtlSeconds: 900 }),
    ).rejects.toThrow(OtaError);
    await expect(
      createOtaJob(prisma, { projectId, releaseId, createdBy: randomUUID(), deviceIds: [deviceIds[0]!, deviceIds[0]!], targetTtlSeconds: 900 }),
    ).rejects.toThrow(/duplicate/);
    await expect(
      createOtaJob(prisma, {
        projectId,
        releaseId,
        createdBy: randomUUID(),
        deviceIds: Array.from({ length: MAX_OTA_TARGETS + 1 }, () => randomUUID()),
        targetTtlSeconds: 900,
      }),
    ).rejects.toThrow(/too many/);
  });

  test("unknown target device -> target_not_found", async () => {
    await expect(
      createOtaJob(prisma, {
        projectId,
        releaseId,
        createdBy: randomUUID(),
        deviceIds: [randomUUID()],
        targetTtlSeconds: 900,
      }),
    ).rejects.toMatchObject({ kind: "target_not_found" });
  });

  test("device from another project -> target_not_in_project", async () => {
    const outsider = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `ota-x-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-ota-x",
        passwordHash: "unused",
        projectId: otherProjectId,
      },
    });
    try {
      await expect(
        createOtaJob(prisma, {
          projectId,
          releaseId,
          createdBy: randomUUID(),
          deviceIds: [outsider.id],
          targetTtlSeconds: 900,
        }),
      ).rejects.toMatchObject({ kind: "target_not_in_project" });
    } finally {
      await prisma.device.delete({ where: { id: outsider.id } });
    }
  });

  test("release from another project -> release_not_in_project", async () => {
    const otherRelease = await createFirmwareRelease(prisma, {
      projectId: otherProjectId,
      bin: new Uint8Array([9, 9]),
    });
    try {
      await expect(
        createOtaJob(prisma, {
          projectId,
          releaseId: otherRelease.releaseId,
          createdBy: randomUUID(),
          deviceIds,
          targetTtlSeconds: 900,
        }),
      ).rejects.toMatchObject({ kind: "release_not_in_project" });
    } finally {
      await prisma.firmwareRelease.delete({ where: { id: otherRelease.releaseId } });
    }
  });
});

describe("target state machine", () => {
  /** Creates a fresh, isolated target (all other targets are expired). */
  async function freshTarget(): Promise<string> {
    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds,
      targetTtlSeconds: 900,
    });
    const row = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    // isolate: expire other claimable targets (terminal rows stay as-is)
    await prisma.otaTarget.updateMany({
      where: { id: { not: row!.id }, state: { in: ["pending", "leased"] } },
      data: { state: "expired", leaseExpiresAt: null },
    });
    return row!.id;
  }

  test("leaseNextOtaTarget claims the oldest pending target", async () => {
    const targetId = await freshTarget();
    const leased = await leaseNextOtaTarget(prisma, 60_000);
    expect(leased).not.toBeNull();
    expect(leased!.id).toBe(targetId);
    expect(leased!.deviceUid).toBe(deviceUid);
    expect(leased!.releaseId).toBe(releaseId);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("leased");
    expect(row?.leaseExpiresAt).not.toBeNull();
  });

  test("a live lease blocks re-claiming", async () => {
    const targetId = await freshTarget();
    expect((await leaseNextOtaTarget(prisma, 60_000))?.id).toBe(targetId);
    expect(await leaseNextOtaTarget(prisma, 60_000)).toBeNull();
  });

  test("an expired lease can be claimed again", async () => {
    const targetId = await freshTarget();
    await leaseNextOtaTarget(prisma, 60_000);
    await prisma.otaTarget.update({
      where: { id: targetId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const leased = await leaseNextOtaTarget(prisma, 60_000);
    expect(leased?.id).toBe(targetId);
  });

  test("releaseOtaTarget returns to pending with backoff", async () => {
    const targetId = await freshTarget();
    await leaseNextOtaTarget(prisma, 60_000);
    await releaseOtaTarget(prisma, targetId, 60_000);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("pending");
    expect(row?.leaseExpiresAt).toBeNull();
    // backoff: not claimable immediately
    expect(await leaseNextOtaTarget(prisma, 60_000)).toBeNull();
    // ...but claimable after the backoff passes
    await prisma.otaTarget.update({
      where: { id: targetId },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    expect((await leaseNextOtaTarget(prisma, 60_000))?.id).toBe(targetId);
  });

  test("markOtaTargetDelivered completes the target", async () => {
    const targetId = await freshTarget();
    const leased = await leaseNextOtaTarget(prisma, 60_000);
    expect(leased?.id).toBe(targetId);
    await markOtaTargetDelivered(prisma, targetId);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("delivered");
    expect(row?.deliveredAt).not.toBeNull();
    // delivered targets are never leased again
    expect(await leaseNextOtaTarget(prisma, 60_000)).toBeNull();
  });

  test("expireOtaTargets moves past-deadline targets to expired", async () => {
    const targetId = await freshTarget();
    await prisma.otaTarget.update({
      where: { id: targetId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await expireOtaTargets(prisma);
    expect(expired).toBeGreaterThanOrEqual(1);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("expired");
    expect(await leaseNextOtaTarget(prisma, 60_000)).toBeNull();
  });
});
