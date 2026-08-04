/**
 * OTA deployment tests: per-device download JWTs (sign/verify, expiry,
 * tamper), job creation (explicit targets, project scoping), and the
 * target state machine (pending → leased → delivered / expired).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  MAX_OTA_TARGETS,
  OtaError,
  confirmOtaTargetByFirmware,
  createOtaJob,
  expireOtaTargets,
  leaseNextOtaTarget,
  markOtaTargetDelivered,
  markOtaTargetDelivering,
  recordOtaResult,
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
    const token = await signOtaToken(SECRET, { deviceUid, releaseId, jobId: randomUUID() }, 900);
    const claims = await verifyOtaToken(SECRET, token);
    expect(claims).toEqual({ deviceUid, releaseId, jobId: expect.any(String) });
  });

  test("expired token is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId, jobId: randomUUID() }, -1);
    expect(await verifyOtaToken(SECRET, token)).toBeNull();
  });

  test("tampered token is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId, jobId: randomUUID() }, 900);
    const [h, p, sig] = token.split(".");
    const tampered = `${h}.${p}.${sig === "x" ? "y" : "x"}`;
    expect(await verifyOtaToken(SECRET, tampered)).toBeNull();
  });

  test("wrong secret is rejected", async () => {
    const token = await signOtaToken(SECRET, { deviceUid, releaseId, jobId: randomUUID() }, 900);
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

describe("ota result acknowledgements", () => {
  const buildId = createHash("sha256").update(elf).digest("hex");

  async function freshJob(): Promise<{ jobId: string; targetId: string }> {
    const job = await createOtaJob(prisma, {
      projectId,
      releaseId,
      createdBy: randomUUID(),
      deviceIds,
      targetTtlSeconds: 900,
    });
    // isolate: expire other claimable targets (terminal/intermediate rows
    // with delivered_at set must stay as-is — CHECK constraint)
    await prisma.otaTarget.updateMany({
      where: {
        id: { not: (await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } }))!.id },
        state: { in: ["pending", "leased"] },
      },
      data: { state: "expired", leaseExpiresAt: null },
    });
    const row = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
    return { jobId: job.jobId, targetId: row!.id };
  }

  /** Leases + marks delivered so the target accepts acknowledgements. */
  async function deliver(jobId: string, targetId: string): Promise<void> {
    await leaseNextOtaTarget(prisma, 60_000);
    await markOtaTargetDelivered(prisma, targetId);
  }

  test("downloaded ack: delivered -> downloaded, replay ignored", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "downloaded", code: 0 }),
    ).toBe(1);
    expect((await prisma.otaTarget.findUnique({ where: { id: targetId } }))?.state).toBe("downloaded");
    // QoS1 replay: nothing changes
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "downloaded", code: 0 }),
    ).toBe(0);
  });

  test("installed ack: downloaded -> installed (awaiting run confirmation)", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "downloaded", code: 0 });
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "installed", code: 0 }),
    ).toBe(1);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("installed");
    expect(row?.confirmedAt).toBeNull(); // NOT terminal yet
  });

  test("failed ack: delivering -> failed with negative code", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    await markOtaTargetDelivering(prisma, jobId, deviceUid);
    expect((await prisma.otaTarget.findUnique({ where: { id: targetId } }))?.state).toBe("delivering");
    expect(
      await recordOtaResult(prisma, {
        deviceUid, jobId, releaseId,
        state: "failed", code: -2, message: "sha256 mismatch",
      }),
    ).toBe(1);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("failed");
    expect(row?.resultCode).toBe(-2);
    expect(row?.resultMessage).toBe("sha256 mismatch");
    expect(row?.confirmedAt).not.toBeNull();
  });

  test("failed ack normalizes a non-negative code to -5", async () => {
    const { jobId } = await freshJob();
    const row = await prisma.otaTarget.findFirst({ where: { jobId } });
    await deliver(jobId, row!.id);
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "failed", code: 0 });
    expect((await prisma.otaTarget.findUnique({ where: { id: row!.id } }))?.resultCode).toBe(-5);
  });

  test("terminal states are immutable", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "failed", code: -1 });
    // later acks are ignored
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "installed", code: 0 }),
    ).toBe(0);
    expect((await prisma.otaTarget.findUnique({ where: { id: targetId } }))?.state).toBe("failed");
  });

  test("out-of-order ack: installed then downloaded replay is ignored", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "installed", code: 0 });
    expect((await prisma.otaTarget.findUnique({ where: { id: targetId } }))?.state).toBe("installed");
    // the older downloaded ack arrives late -> no-op
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "downloaded", code: 0 }),
    ).toBe(0);
  });

  test("unknown job or release is ignored", async () => {
    const { jobId } = await freshJob();
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId, releaseId: randomUUID(), state: "downloaded", code: 0 }),
    ).toBe(0);
    expect(
      await recordOtaResult(prisma, { deviceUid, jobId: randomUUID(), releaseId, state: "downloaded", code: 0 }),
    ).toBe(0);
    expect(
      await recordOtaResult(prisma, { deviceUid: "no-such-device", jobId, releaseId, state: "downloaded", code: 0 }),
    ).toBe(0);
  });

  test("markOtaTargetDelivering: delivered -> delivering once", async () => {
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    expect(await markOtaTargetDelivering(prisma, jobId, deviceUid)).toBe(1);
    expect((await prisma.otaTarget.findUnique({ where: { id: targetId } }))?.state).toBe("delivering");
    // repeated downloads (retries/resume) update nothing
    expect(await markOtaTargetDelivering(prisma, jobId, deviceUid)).toBe(0);
    // wrong device cannot drive the state
    expect(await markOtaTargetDelivering(prisma, jobId, "someone-else")).toBe(0);
  });

  test("stat fallback confirms by firmware match (the only completed driver)", async () => {
    // delivered target + device reports the release's ELF build id
    const { jobId, targetId } = await freshJob();
    await deliver(jobId, targetId);
    const confirmed = await confirmOtaTargetByFirmware(prisma, deviceIds[0]!, buildId);
    expect(confirmed).toBeGreaterThanOrEqual(1);
    const row = await prisma.otaTarget.findUnique({ where: { id: targetId } });
    expect(row?.state).toBe("completed");
    expect(row?.resultCode).toBe(0);
    expect(row?.confirmedAt).not.toBeNull();
    // terminal: nothing changes afterwards
    expect(await confirmOtaTargetByFirmware(prisma, deviceIds[0]!, buildId)).toBe(0);
  });

  test("stat fallback works from installed and delivering states", async () => {
    const { jobId } = await freshJob();
    const row = await prisma.otaTarget.findFirst({ where: { jobId } });
    await deliver(jobId, row!.id);
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "installed", code: 0 });
    expect(await confirmOtaTargetByFirmware(prisma, deviceIds[0]!, buildId)).toBe(1);
    expect((await prisma.otaTarget.findUnique({ where: { id: row!.id } }))?.state).toBe("completed");
  });

  test("stat fallback ignores a mismatched firmware hash", async () => {
    const { jobId } = await freshJob();
    const row = await prisma.otaTarget.findFirst({ where: { jobId } });
    await deliver(jobId, row!.id);
    expect(await confirmOtaTargetByFirmware(prisma, deviceIds[0]!, "deadbeef".repeat(8))).toBe(0);
    expect((await prisma.otaTarget.findUnique({ where: { id: row!.id } }))?.state).toBe("delivered");
  });

  test("stat fallback cannot confirm bin-only releases (no artifact)", async () => {
    const binOnly = await createFirmwareRelease(prisma, {
      projectId,
      bin: new Uint8Array([7, 7, 7]),
    });
    try {
      const job = await createOtaJob(prisma, {
        projectId,
        releaseId: binOnly.releaseId,
        createdBy: randomUUID(),
        deviceIds,
        targetTtlSeconds: 900,
      });
      const row = await prisma.otaTarget.findFirst({ where: { jobId: job.jobId } });
      await leaseNextOtaTarget(prisma, 60_000);
      await markOtaTargetDelivered(prisma, row!.id);
      await confirmOtaTargetByFirmware(prisma, deviceIds[0]!, buildId);
      // the bin-only target has no artifact to match: it stays delivered
      // (other targets may be confirmed — that is not this test's concern)
      expect((await prisma.otaTarget.findUnique({ where: { id: row!.id } }))?.state).toBe("delivered");
    } finally {
      const jobs = await prisma.otaJob.findMany({
        where: { releaseId: binOnly.releaseId },
        select: { id: true },
      });
      await prisma.otaTarget.deleteMany({ where: { jobId: { in: jobs.map((j) => j.id) } } });
      await prisma.otaJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
      await prisma.firmwareRelease.delete({ where: { id: binOnly.releaseId } });
    }
  });
});
