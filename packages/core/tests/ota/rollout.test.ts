/**
 * OTA rollout tests: creation (auto/grouped), the advance loop (gating,
 * timeout, manual approval, stall judgement, completion), and lifecycle
 * operations (pause/resume/abort/rollback).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  OtaError,
  confirmOtaTargetByFirmware,
  recordOtaResult,
} from "../../src/ota/deploy";
import { createFirmwareRelease } from "../../src/ota/release";
import {
  abortRollout,
  advanceRollouts,
  createOtaRollout,
  pauseRollout,
  resumeRollout,
  rollbackRollout,
} from "../../src/ota/rollout";
import { buildNoloadElf } from "../helpers/elf-builder";

const elf = buildNoloadElf(["value=%d"], ["demo"], 32, true);
const elfHash = createHash("sha256").update(elf).digest("hex");

let projectId: string;
let releaseId: string;
let fromReleaseId: string;
let deviceIds: string[];

async function freshDevices(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `roll-${randomUUID().slice(0, 8)}`,
        assignedId: `assigned-roll-${randomUUID().slice(0, 8)}`,
        passwordHash: "unused",
        projectId,
      },
    });
    ids.push(d.id);
  }
  return ids;
}

/** Delivers a job's target and (optionally) acks it through to a state. */
async function driveTarget(
  jobId: string,
  deviceUid: string,
  through: "delivered" | "downloaded" | "installed" | "completed",
): Promise<void> {
  const row = await prisma.otaTarget.findFirst({ where: { jobId, device: { deviceUid } } });
  if (!row) throw new Error(`no target for ${deviceUid}`);
  // simulate the broker delivery directly (the lease machinery is the
  // broker's concern; these tests exercise the ack/state path only)
  await prisma.otaTarget.update({
    where: { id: row.id },
    data: { state: "delivered", deliveredAt: new Date() },
  });
  if (through === "delivered") return;
  if (through === "downloaded" || through === "installed" || through === "completed") {
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "downloaded", code: 0 });
  }
  if (through === "installed" || through === "completed") {
    await recordOtaResult(prisma, { deviceUid, jobId, releaseId, state: "installed", code: 0 });
  }
  if (through === "completed") {
    // completed is ONLY driven by the stat.fw fact layer (proposal 18 D6)
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId: row.deviceId },
      update: { fwHash: elfHash, reportedAt: new Date() },
      create: { deviceId: row.deviceId, fwHash: elfHash },
    });
    await confirmOtaTargetByFirmware(prisma, row.deviceId, elfHash);
  }
}

async function jobTargets(jobId: string | null): Promise<Array<{ state: string; deviceUid: string }>> {
  if (!jobId) return [];
  const rows = await prisma.otaTarget.findMany({
    where: { jobId },
    select: { state: true, device: { select: { deviceUid: true } } },
  });
  return rows.map((r) => ({ state: r.state, deviceUid: r.device.deviceUid }));
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "rollout-test" } });
  const target = await createFirmwareRelease(prisma, { projectId, bin: new Uint8Array([1, 2, 3]), elf });
  releaseId = target.releaseId;
  const from = await createFirmwareRelease(prisma, {
    projectId,
    bin: new Uint8Array([9, 9, 9]),
    elf: buildNoloadElf(["old=%d"], ["old"], 32, true),
  });
  fromReleaseId = from.releaseId;
  deviceIds = await freshDevices(8);
});

afterAll(async () => {
  await prisma.otaTarget.deleteMany({ where: { job: { projectId } } });
  await prisma.otaJob.deleteMany({ where: { projectId } });
  await prisma.otaRolloutPool.deleteMany({ where: { rollout: { projectId } } });
  await prisma.otaRolloutPhase.deleteMany({ where: { rollout: { projectId } } });
  await prisma.otaRollout.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.firmwareRelease.deleteMany({ where: { projectId } });
  await prisma.firmwareLogString.deleteMany({ where: { artifact: { projectId } } });
  await prisma.firmwareArtifact.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("createOtaRollout", () => {
  test("auto: random pool, phases from ratios, phase 1 active with a job", async () => {
    const created = await createOtaRollout(prisma, {
      projectId,
      releaseId,
      fromReleaseId,
      strategy: "auto",
      deviceIds,
      ratios: [0.5, 1.0],
      createdBy: randomUUID(),
    });
    expect(created.phases).toHaveLength(2);
    expect(created.phases[0]).toMatchObject({ index: 1, target_count: 4, state: "active" });
    expect(created.phases[1]).toMatchObject({ index: 2, target_count: 8, state: "pending" });
    expect(created.jobId).not.toBeNull();
    const targets = await jobTargets(created.jobId);
    expect(targets).toHaveLength(4);
    // pool snapshot recorded
    const pool = await prisma.otaRolloutPool.count({ where: { rolloutId: created.rolloutId } });
    expect(pool).toBe(8);
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("grouped: client groups become phases in order", async () => {
    const g1 = deviceIds.slice(0, 2);
    const g2 = deviceIds.slice(2, 5);
    const created = await createOtaRollout(prisma, {
      projectId,
      releaseId,
      strategy: "grouped",
      groups: [{ device_ids: g1 }, { device_ids: g2 }],
      createdBy: randomUUID(),
    });
    expect(created.phases).toEqual([
      { index: 1, target_count: 2, state: "active" },
      { index: 2, target_count: 3, state: "pending" },
    ]);
    const targets = await jobTargets(created.jobId);
    expect(targets.map((t) => t.deviceUid).sort()).toEqual(
      (
        await prisma.device.findMany({ where: { id: { in: g1 } }, select: { deviceUid: true } })
      )
        .map((d) => d.deviceUid)
        .sort(),
    );
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("validation errors", async () => {
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "auto", deviceIds: [], createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "empty_targets" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "auto",
        deviceIds: [deviceIds[0]!, deviceIds[0]!], createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "duplicate_targets" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "auto",
        deviceIds, ratios: [0.5, 0.3], createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "invalid_ratios" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "auto",
        deviceIds, ratios: [0.5], createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "invalid_ratios" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "grouped",
        groups: [{ device_ids: deviceIds.slice(0, 2) }, { device_ids: deviceIds.slice(1, 3) }],
        createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "groups_overlap" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, fromReleaseId: releaseId, strategy: "auto",
        deviceIds, createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "invalid_from_release" });
    await expect(
      createOtaRollout(prisma, {
        projectId, releaseId, strategy: "auto",
        deviceIds: [randomUUID()], createdBy: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "target_not_found" });
  });
});

describe("advance loop", () => {
  test("phase completion activates the next phase (auto)", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 6), ratios: [0.5, 1.0],
      createdBy: randomUUID(),
    });
    const job1 = created.jobId!;
    const t1 = await jobTargets(job1);
    // drive all phase-1 targets to completed (3 of 3 -> ratio 0.5 met)
    for (const t of t1) {
      await driveTarget(job1, t.deviceUid, "completed");
    }
    const s1 = await advanceRollouts(prisma);
    expect(s1.phasesCompleted).toBeGreaterThanOrEqual(1);
    // phase 2 is now active with its own job
    const phase2 = await prisma.otaRolloutPhase.findFirst({
      where: { rolloutId: created.rolloutId, index: 2 },
    });
    expect(phase2?.state).toBe("active");
    expect(phase2?.jobId).not.toBeNull();
    const t2 = await jobTargets(phase2?.jobId ?? null);
    expect(t2).toHaveLength(3); // 6 devices * 1.0 - 3 already done
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("timeout without meeting the threshold pauses the rollout", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 4), ratios: [1.0],
      phaseTimeoutHours: 1,
      createdBy: randomUUID(),
    });
    // backdate the activation past the timeout
    await prisma.otaRolloutPhase.update({
      where: { rolloutId_index: { rolloutId: created.rolloutId, index: 1 } },
      data: { activatedAt: new Date(Date.now() - 2 * 3600_000) },
    });
    const s = await advanceRollouts(prisma);
    expect(s.rolloutsPaused).toBeGreaterThanOrEqual(1);
    const rollout = await prisma.otaRollout.findUnique({ where: { id: created.rolloutId } });
    expect(rollout?.state).toBe("paused");
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("manual_approval: a met phase waits for resume", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 4), ratios: [0.5, 1.0],
      manualApproval: true,
      createdBy: randomUUID(),
    });
    for (const t of await jobTargets(created.jobId!)) {
      await driveTarget(created.jobId!, t.deviceUid, "completed");
    }
    await advanceRollouts(prisma);
    const phase1 = await prisma.otaRolloutPhase.findUnique({
      where: { rolloutId_index: { rolloutId: created.rolloutId, index: 1 } },
    });
    const phase2 = await prisma.otaRolloutPhase.findUnique({
      where: { rolloutId_index: { rolloutId: created.rolloutId, index: 2 } },
    });
    expect(phase1?.state).toBe("completed");
    expect(phase2?.state).toBe("pending"); // waiting, not activated
    // resume activates it
    expect(await resumeRollout(prisma, created.rolloutId)).toBe(true);
    await advanceRollouts(prisma);
    const phase2After = await prisma.otaRolloutPhase.findUnique({
      where: { rolloutId_index: { rolloutId: created.rolloutId, index: 2 } },
    });
    expect(phase2After?.state).toBe("active");
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("all phases completed -> rollout completed", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [1.0],
      createdBy: randomUUID(),
    });
    for (const t of await jobTargets(created.jobId!)) {
      await driveTarget(created.jobId!, t.deviceUid, "completed");
    }
    await advanceRollouts(prisma);
    const rollout = await prisma.otaRollout.findUnique({ where: { id: created.rolloutId } });
    expect(rollout?.state).toBe("completed");
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("stall judgement: alive device with mismatched fw -> failed (-6)", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [1.0],
      stuckHours: 1,
      createdBy: randomUUID(),
    });
    const jobId = created.jobId!;
    const t = (await jobTargets(jobId))[0]!;
    await driveTarget(jobId, t.deviceUid, "installed");
    // backdate installed_at past the stuck window; device is ALIVE
    // (reported_at fresh) but reports the OLD firmware
    const row = await prisma.otaTarget.findFirst({
      where: { jobId, device: { deviceUid: t.deviceUid } },
    });
    await prisma.otaTarget.update({
      where: { id: row!.id },
      data: { installedAt: new Date(Date.now() - 2 * 3600_000) },
    });
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId: row!.deviceId },
      update: { fwHash: "deadbeef".repeat(8), reportedAt: new Date() },
      create: { deviceId: row!.deviceId, fwHash: "deadbeef".repeat(8) },
    });
    const s2 = await advanceRollouts(prisma);
    expect(s2.targetsStalled).toBeGreaterThanOrEqual(1);
    const after = await prisma.otaTarget.findUnique({ where: { id: row!.id } });
    expect(after?.state).toBe("failed");
    expect(after?.resultCode).toBe(-6);
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("stall judgement spares an INACTIVE device (powered off)", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [1.0],
      stuckHours: 1,
      createdBy: randomUUID(),
    });
    const jobId = created.jobId!;
    const t = (await jobTargets(jobId))[0]!;
    await driveTarget(jobId, t.deviceUid, "installed");
    const row = await prisma.otaTarget.findFirst({
      where: { jobId, device: { deviceUid: t.deviceUid } },
    });
    await prisma.otaTarget.update({
      where: { id: row!.id },
      data: { installedAt: new Date(Date.now() - 2 * 3600_000) },
    });
    // device is NOT alive: last stat was 3 hours ago
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId: row!.deviceId },
      update: { fwHash: "deadbeef".repeat(8), reportedAt: new Date(Date.now() - 3 * 3600_000) },
      create: { deviceId: row!.deviceId, fwHash: "deadbeef".repeat(8) },
    });
    const s2 = await advanceRollouts(prisma);
    const after = await prisma.otaTarget.findUnique({ where: { id: row!.id } });
    expect(after?.state).toBe("installed"); // spared
    void s2;
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });
});

describe("lifecycle", () => {
  test("pause / resume / abort transitions", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [0.5, 1.0],
      createdBy: randomUUID(),
    });
    expect(await pauseRollout(prisma, created.rolloutId)).toBe(true);
    // pausing twice is a no-op
    expect(await pauseRollout(prisma, created.rolloutId)).toBe(false);
    expect(await resumeRollout(prisma, created.rolloutId)).toBe(true);
    expect(await abortRollout(prisma, created.rolloutId)).toBe(true);
    // aborted rollouts cannot be resumed
    expect(await resumeRollout(prisma, created.rolloutId)).toBe(false);
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("rollback: aborts and creates a from_release job for completed devices", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, fromReleaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 3), ratios: [1.0],
      createdBy: randomUUID(),
    });
    // one device completes the upgrade
    const t = (await jobTargets(created.jobId!))[0]!;
    await driveTarget(created.jobId!, t.deviceUid, "completed");

    const result = await rollbackRollout(prisma, created.rolloutId);
    expect(result.targetDevices).toBe(1);
    const rollout = await prisma.otaRollout.findUnique({ where: { id: created.rolloutId } });
    expect(rollout?.state).toBe("aborted");
    expect(rollout?.rollbackJobId).toBe(result.rollbackJobId);
    const job = await prisma.otaJob.findUnique({
      where: { id: result.rollbackJobId },
      include: { targets: { select: { state: true } } },
    });
    expect(job?.releaseId).toBe(fromReleaseId);
    expect(job?.targets).toHaveLength(1);
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("rollback without completed devices -> rollback_unavailable", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, fromReleaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [1.0],
      createdBy: randomUUID(),
    });
    await expect(rollbackRollout(prisma, created.rolloutId)).rejects.toMatchObject({
      kind: "rollback_unavailable",
    });
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });

  test("rollout without from_release_id cannot roll back", async () => {
    const created = await createOtaRollout(prisma, {
      projectId, releaseId, strategy: "auto",
      deviceIds: deviceIds.slice(0, 2), ratios: [1.0],
      createdBy: randomUUID(),
    });
    await expect(rollbackRollout(prisma, created.rolloutId)).rejects.toMatchObject({
      kind: "rollback_unavailable",
    });
    await prisma.otaRollout.delete({ where: { id: created.rolloutId } });
  });
});
