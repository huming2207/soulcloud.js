/**
 * OTA rollout: phased firmware deployment over a device pool (proposal 19).
 *
 * The rollout is a thin shell over the existing ota_job machinery:
 *
 *   - a phase, when activated, creates an ORDINARY ota_job for its device
 *     slice — delivery, acknowledgements and stat.fw confirmation are
 *     untouched
 *   - the advance loop (API process, 30s) judges each active phase:
 *       met   (completed ≥ ratio × actual, and ≥ min(min_sample, actual))
 *              → phase completed, next phase activated (or waits for
 *                manual approval / resume)
 *       timed out (phase_timeout_hours without meeting) → rollout paused
 *       stalled   (installed > stuck_hours AND device alive with a
 *                mismatched fw) → target failed (code -6)
 *   - rollback = an ota_job for from_release_id targeting the completed
 *     devices of this rollout
 *
 * Concurrency: all state transitions use conditional UPDATEs
 * (WHERE state = ...), so multiple API instances running the loop are
 * safe — the loser updates 0 rows.
 */

import { randomUUID, randomInt } from "node:crypto";
import type { Prisma, PrismaClient } from "../db";
import { MAX_OTA_TARGETS, OtaError, resolveReleaseExpectedFirmware } from "./deploy";
import { NOTIFICATIONS_CHANNEL, OTA_NOTIFY_CHANNEL } from "../queue/notify";

/** Default auto-strategy ratios (cumulative; last must be 1.0). */
export const DEFAULT_AUTO_RATIOS = [0.05, 0.25, 1.0] as const;

/** Failure code for "device is alive but does not run the target fw". */
export const OTA_STALL_FAILURE_CODE = -6;

/**
 * Default delivery window for rollout phase/rollback targets (15 min).
 * The API process passes its configured OTA_TARGET_TTL_SECONDS through
 * createOtaRollout / advanceRollouts / resumeRollout / rollbackRollout.
 */
export const DEFAULT_ROLLOUT_TARGET_TTL_SECONDS = 15 * 60;

type TransactionClient = Prisma.TransactionClient;

export interface CreateRolloutOptions {
  projectId: string;
  releaseId: string;
  /** Baseline firmware for rollback (must be an existing release). */
  fromReleaseId?: string;
  strategy: "auto" | "grouped";
  /** auto: the full device pool (randomized server-side). */
  deviceIds?: string[];
  /** auto: cumulative ratios, ascending, last = 1.0. */
  ratios?: number[];
  /** grouped: client-chosen groups, one phase per group. */
  groups?: Array<{ device_ids: string[] }>;
  successRatio?: number;
  minSample?: number;
  phaseTimeoutHours?: number;
  stuckHours?: number;
  manualApproval?: boolean;
  /** Delivery window for phase targets (seconds); defaults to 15 min. */
  targetTtlSeconds?: number;
  createdBy: string;
}

export interface CreatedRollout {
  rolloutId: string;
  phases: Array<{ index: number; target_count: number; state: "active" | "pending" }>;
  /** The phase-1 job (created synchronously). */
  jobId: string | null;
}

function validateRatios(ratios: number[]): void {
  if (ratios.length === 0) throw new OtaError("invalid_ratios", "at least one ratio is required");
  for (const r of ratios) {
    if (!(r > 0 && r <= 1)) throw new OtaError("invalid_ratios", "ratios must be in (0, 1]");
  }
  for (let i = 1; i < ratios.length; i++) {
    const prev = ratios[i - 1];
    const cur = ratios[i];
    if (prev === undefined || cur === undefined || cur <= prev) {
      throw new OtaError("invalid_ratios", "ratios must be strictly ascending");
    }
  }
  const last = ratios[ratios.length - 1];
  if (last === undefined || last !== 1.0) {
    throw new OtaError("invalid_ratios", "the last ratio must be exactly 1.0");
  }
}

/** Fisher-Yates shuffle (crypto randomness for the auto strategy). */
function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}


/**
 * Creates a rollout: validates the pool, persists rollout + pool + phases,
 * and activates phase 1 synchronously (a regular ota_job + wake-up).
 *
 * @throws {OtaError}
 */
export async function createOtaRollout(
  prisma: PrismaClient,
  options: CreateRolloutOptions,
): Promise<CreatedRollout> {
  const release = await prisma.firmwareRelease.findUnique({
    where: { id: options.releaseId },
    select: { id: true, projectId: true },
  });
  if (!release || release.projectId !== options.projectId) {
    throw new OtaError("release_not_in_project", "release does not belong to this project");
  }
  if (options.fromReleaseId) {
    const from = await prisma.firmwareRelease.findUnique({
      where: { id: options.fromReleaseId },
      select: { id: true, projectId: true },
    });
    if (!from || from.projectId !== options.projectId) {
      throw new OtaError("release_not_in_project", "from_release_id does not belong to this project");
    }
    if (from.id === options.releaseId) {
      throw new OtaError("invalid_from_release", "from_release_id must differ from the target release");
    }
    void from;
  }

  // ---- pool resolution ----------------------------------------------------
  let poolDeviceIds: string[];
  let phases: Array<{ index: number; ratio: number | null; groupId: number | null; targetCount: number }>;

  if (options.strategy === "auto") {
    if (!options.deviceIds || options.deviceIds.length === 0) {
      throw new OtaError("empty_targets", "an auto rollout needs device_ids");
    }
    const ratios = options.ratios ?? [...DEFAULT_AUTO_RATIOS];
    validateRatios(ratios);
    if (new Set(options.deviceIds).size !== options.deviceIds.length) {
      throw new OtaError("duplicate_targets", "device_ids contains duplicates");
    }
    if (options.deviceIds.length > MAX_OTA_TARGETS) {
      throw new OtaError("too_many_targets", "too many target devices");
    }
    poolDeviceIds = options.deviceIds;
    // ratios are CUMULATIVE coverage: phase k gets the slice
    // [ceil(r_{k-1}*N), ceil(r_k*N)). Empty slices (ratios that add no
    // devices, e.g. tight ratios on a tiny pool) are merged into the
    // next phase instead of creating a phase with a 0-device job that
    // could never meet its gate.
    const n = poolDeviceIds.length;
    const computed: Array<{
      index: number;
      ratio: number | null;
      groupId: number | null;
      targetCount: number;
    }> = [];
    let prior = 0;
    for (const r of ratios) {
      const cumulative = Math.ceil(r * n);
      const size = cumulative - prior;
      if (size <= 0) continue;
      computed.push({
        index: computed.length + 1,
        ratio: r,
        groupId: null,
        targetCount: size,
      });
      prior = cumulative;
    }
    phases = computed;
  } else {
    if (!options.groups || options.groups.length === 0) {
      throw new OtaError("no_phases", "grouped rollouts need at least one group");
    }
    const all: string[] = [];
    const seen = new Set<string>();
    for (const g of options.groups) {
      if (!g.device_ids || g.device_ids.length === 0) {
        throw new OtaError("empty_targets", "a group must contain devices");
      }
      for (const id of g.device_ids) {
        if (seen.has(id)) throw new OtaError("groups_overlap", "groups must not overlap");
        seen.add(id);
        all.push(id);
      }
    }
    if (all.length > MAX_OTA_TARGETS) {
      throw new OtaError("too_many_targets", "too many target devices");
    }
    poolDeviceIds = all;
    phases = options.groups.map((g, i) => ({
      index: i + 1,
      ratio: null,
      groupId: i + 1,
      targetCount: g.device_ids.length,
    }));
  }

  // ---- device existence + project scoping (uniform not-found) -------------
  const devices = await prisma.device.findMany({
    where: { id: { in: poolDeviceIds } },
    select: { id: true, projectId: true, deviceUid: true },
  });
  if (devices.length !== poolDeviceIds.length) {
    throw new OtaError("target_not_found", "one or more target devices do not exist");
  }
  if (devices.some((d) => d.projectId !== options.projectId)) {
    throw new OtaError("target_not_in_project", "one or more target devices do not belong to this project");
  }

  // auto: server-randomized order (deterministic per rollout: one shuffle)
  let ordered: string[];
  if (options.strategy === "auto") {
    ordered = shuffle(poolDeviceIds);
  } else {
    ordered = poolDeviceIds; // client order is the group order
  }

  const rolloutId = randomUUID();
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.otaRollout.create({
        data: {
          id: rolloutId,
          projectId: options.projectId,
          releaseId: options.releaseId,
          fromReleaseId: options.fromReleaseId ?? null,
          strategy: options.strategy,
          successRatio: options.successRatio ?? 0.9,
          minSample: options.minSample ?? 10,
          phaseTimeoutHours: options.phaseTimeoutHours ?? 24,
          stuckHours: options.stuckHours ?? 6,
          manualApproval: options.manualApproval ?? false,
          createdBy: options.createdBy,
        },
      });
      await tx.otaRolloutPool.createMany({
        data: ordered.map((deviceId, i) => ({ rolloutId, deviceId, sortIdx: i })),
      });
      await tx.otaRolloutPhase.createMany({
        data: phases.map((p) => ({
          rolloutId,
          index: p.index,
          ratio: p.ratio,
          groupId: p.groupId,
          targetCount: p.targetCount,
          state: "pending",
        })),
      });

      // activate phase 1 synchronously
      const first = phases[0]!;
      const slice = ordered.slice(0, first.targetCount);
      const ttlMs = (options.targetTtlSeconds ?? DEFAULT_ROLLOUT_TARGET_TTL_SECONDS) * 1000;
      const jobId = await createPhaseJob(tx, rolloutId, first.index, slice, ttlMs);
      await tx.otaRolloutPhase.update({
        where: { rolloutId_index: { rolloutId, index: 1 } },
        data: { state: "active", jobId, activatedAt: now },
      });

      return {
        rolloutId,
        phases: phases.map((p) => ({
          index: p.index,
          target_count: p.targetCount,
          state: (p.index === 1 ? "active" : "pending") as "active" | "pending",
        })),
        jobId,
      };
    });
  } catch (error) {
    if (error instanceof OtaError) throw error;
    throw new OtaError("database", `rollout creation failed: ${(error as Error).message}`);
  }
}

/** Creates a plain ota_job for a device slice (shared by phase + rollback). */
async function createPhaseJob(
  tx: TransactionClient,
  rolloutId: string,
  phaseIndex: number,
  deviceIds: string[],
  ttlMs: number,
): Promise<string> {
  const rollout = await tx.otaRollout.findUniqueOrThrow({
    where: { id: rolloutId },
    select: { projectId: true, releaseId: true, createdBy: true },
  });
  const jobId = randomUUID();
  await tx.otaJob.create({
    data: {
      id: jobId,
      projectId: rollout.projectId,
      releaseId: rollout.releaseId,
      createdBy: rollout.createdBy,
    },
  });
  await createTargetsForRelease(tx, jobId, rollout.releaseId, deviceIds, ttlMs);
  await tx.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
  void phaseIndex;
  return jobId;
}

/**
 * Creates rollout/rollback targets and immediately completes devices already
 * reporting the release identity. This is the same fast path as direct OTA
 * deployment: without it, a device-side dedupe can ignore a redundant notice
 * and leave a rollout phase pending until its timeout.
 */
async function createTargetsForRelease(
  tx: TransactionClient,
  jobId: string,
  releaseId: string,
  deviceIds: string[],
  ttlMs: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await tx.otaTarget.createMany({
    data: deviceIds.map((deviceId) => ({ jobId, deviceId, expiresAt })),
  });

  const expectedFirmware = await resolveReleaseExpectedFirmware(tx, releaseId);
  if (!expectedFirmware) return;
  const states = await tx.deviceFirmwareState.findMany({
    where: { deviceId: { in: deviceIds }, fwHash: expectedFirmware },
    select: { deviceId: true },
  });
  if (states.length === 0) return;
  await tx.otaTarget.updateMany({
    where: {
      jobId,
      deviceId: { in: states.map((state) => state.deviceId) },
      state: "pending",
    },
    data: { state: "completed", confirmedAt: new Date(), resultCode: 0 },
  });
}

// ===========================================================================
// Advance loop + lifecycle operations
// ===========================================================================

export interface AdvanceSummary {
  rolloutsScanned: number;
  phasesActivated: number;
  phasesCompleted: number;
  rolloutsPaused: number;
  rolloutsCompleted: number;
  targetsStalled: number;
  /** Rollouts whose pass threw; the loop keeps scanning the rest. */
  rolloutsErrored: number;
}

/**
 * One advance pass over all running rollouts (called by the API process
 * poller every ROLLOUT_POLL_INTERVAL_MS):
 *
 *   1. per rollout: judge the active phase
 *      - met the success threshold  -> phase completed; activate the next
 *        phase unless manual_approval (then it waits for resume)
 *      - timed out (phase_timeout_hours) -> rollout paused
 *   2. stall judgement for installed targets of active phases
 *      - installed > stuck_hours AND device alive (stat within 1h) AND
 *        fw mismatch -> failed (code -6)
 *   3. all phases completed -> rollout completed
 *
 * Every transition is a conditional UPDATE; concurrent instances are safe.
 */
export async function advanceRollouts(
  prisma: PrismaClient,
  options: { targetTtlSeconds?: number } = {},
): Promise<AdvanceSummary> {
  const summary: AdvanceSummary = {
    rolloutsScanned: 0,
    phasesActivated: 0,
    phasesCompleted: 0,
    rolloutsPaused: 0,
    rolloutsCompleted: 0,
    targetsStalled: 0,
    rolloutsErrored: 0,
  };
  const ttlMs = (options.targetTtlSeconds ?? DEFAULT_ROLLOUT_TARGET_TTL_SECONDS) * 1000;

  const rollouts = await prisma.otaRollout.findMany({
    where: { state: "running" },
    select: { id: true },
  });
  summary.rolloutsScanned = rollouts.length;

  for (const { id } of rollouts) {
    try {
      await advanceOneRollout(prisma, id, ttlMs, summary);
    } catch (error) {
      // per-rollout isolation: one broken rollout must not stall the
      // scan for every other rollout behind it
      summary.rolloutsErrored += 1;
      console.error("[rollout] advance pass failed for rollout", id, (error as Error).message);
    }
  }

  return summary;
}

async function notifyRolloutEvent(
  prisma: PrismaClient,
  type: "manual_approval" | "completed" | "paused" | "aborted" | "resumed",
  rolloutId: string,
  projectId: string,
): Promise<void> {
  try {
    await prisma.$executeRaw`SELECT pg_notify(
      ${NOTIFICATIONS_CHANNEL},
      ${JSON.stringify({ type, rollout_id: rolloutId, project_id: projectId })}
    )`;
  } catch {
    // notification failure must never affect the rollout state machine
  }
}

/** One pass for a single running rollout (extracted for error isolation). */
async function advanceOneRollout(
  prisma: PrismaClient,
  id: string,
  ttlMs: number,
  summary: AdvanceSummary,
): Promise<void> {    const rollout = await prisma.otaRollout.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        successRatio: true,
        minSample: true,
        phaseTimeoutHours: true,
        stuckHours: true,
        manualApproval: true,
        phases: {
          orderBy: { index: "asc" },
          select: {
            id: true,
            index: true,
            state: true,
            targetCount: true,
            activatedAt: true,
            jobId: true,
          },
        },
      },
    });
    if (!rollout) return;

    const active = rollout.phases.find((p) => p.state === "active");
    if (!active) {
      // no active phase: activate the next pending one — UNLESS the
      // rollout waits for manual approval (a fixed advance loop would
      // otherwise bypass the wait on its very next pass)
      const next = rollout.phases.find((p) => p.state === "pending");
      if (next && !rollout.manualApproval) {
        const activated = await activatePendingPhase(prisma, rollout.id, next.index, ttlMs);
        if (activated) summary.phasesActivated += 1;
      }
      // all phases terminal -> completed
      const allTerminal = rollout.phases.every((p) => p.state === "completed");
      if (allTerminal) {
        const done = await prisma.otaRollout.updateMany({
          where: { id: rollout.id, state: "running" },
          data: { state: "completed" },
        });
        if (done.count > 0) {
          summary.rolloutsCompleted += 1;
          await notifyRolloutEvent(prisma, "completed", rollout.id, rollout.projectId);
        }
      }
      return;
    }

    // ---- judge the active phase ------------------------------------------
    const job = active.jobId
      ? await prisma.otaJob.findUnique({
          where: { id: active.jobId },
          select: { id: true, targets: { select: { state: true } } },
        })
      : null;
    const actual = job?.targets.length ?? 0;
    const completed = job?.targets.filter((t) => t.state === "completed").length ?? 0;
    const met =
      actual > 0 &&
      completed / actual >= rollout.successRatio &&
      completed >= Math.min(rollout.minSample, actual);

    const timedOut =
      active.activatedAt !== null &&
      Date.now() - active.activatedAt.getTime() > rollout.phaseTimeoutHours * 3600_000;

    if (met) {
      const finished = await prisma.otaRolloutPhase.updateMany({
        where: { id: active.id, state: "active" },
        data: { state: "completed", completedAt: new Date() },
      });
      if (finished.count === 0) return; // another instance handled it
      summary.phasesCompleted += 1;

      const next = rollout.phases.find((p) => p.state === "pending");
      if (next && !rollout.manualApproval) {
        const activated = await activatePendingPhase(prisma, rollout.id, next.index, ttlMs);
        if (activated) summary.phasesActivated += 1;
      } else if (!next) {
        // last phase met its threshold: the rollout is complete (same pass)
        const done = await prisma.otaRollout.updateMany({
          where: { id: rollout.id, state: "running" },
          data: { state: "completed" },
        });
        if (done.count > 0) {
          summary.rolloutsCompleted += 1;
          await notifyRolloutEvent(prisma, "completed", rollout.id, rollout.projectId);
        }
      } else {
        // manual_approval with a next phase: it waits; the rollout stays
        // running with no active phase until resume is called
        await notifyRolloutEvent(prisma, "manual_approval", rollout.id, rollout.projectId);
      }
    } else if (timedOut) {
      const paused = await prisma.$transaction([
        prisma.otaRollout.updateMany({
          where: { id: rollout.id, state: "running" },
          data: { state: "paused" },
        }),
        prisma.otaRolloutPhase.updateMany({
          where: { id: active.id, state: "active" },
          data: { state: "paused" },
        }),
      ]);
      if (paused[0]!.count > 0) {
        summary.rolloutsPaused += 1;
        await notifyRolloutEvent(prisma, "paused", rollout.id, rollout.projectId);
      }
    } else {
      // ---- stall judgement for installed targets -------------------------
      summary.targetsStalled += await judgeInstalledTargets(
        prisma,
        active.jobId,
        rollout.stuckHours,
      );
    }
}

/** Installed > stuck_hours AND alive-with-mismatch -> failed (-6). */
async function judgeInstalledTargets(
  prisma: PrismaClient,
  jobId: string | null,
  stuckHours: number,
): Promise<number> {
  if (!jobId) return 0;
  // device firmware state join: reported_at (aliveness) + fwHash (mismatch)
  const stalled = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE ota_targets t
    SET state = 'failed',
        confirmed_at = now(),
        result_code = ${OTA_STALL_FAILURE_CODE},
        result_message = 'upgrade not active: device alive but firmware unchanged'
    FROM ota_jobs j, firmware_releases r, firmware_artifacts a,
         devices d, device_firmware_state s
    WHERE t.job_id = j.id
      AND j.release_id = r.id
      AND r.artifact_id = a.id
      AND t.device_id = d.id
      AND s.device_id = d.id
      AND t.job_id = ${jobId}
      AND t.state = 'installed'
      AND t.installed_at < now() - make_interval(secs => ${stuckHours * 3600}::double precision)
      AND s.reported_at > now() - interval '1 hour'
      AND s.fw_hash <> a."buildId"
    RETURNING t.id
  `;
  return stalled.length;
}

/**
 * Activates the next pending phase: conditional phase transition + a
 * regular ota_job for the phase's device slice (cumulative sort_idx range).
 */
async function activatePendingPhase(
  prisma: PrismaClient,
  rolloutId: string,
  phaseIndex: number,
  ttlMs: number,
): Promise<boolean> {
  // single transaction: the phase claim, job creation and jobId write are
  // atomic. A crash/failure anywhere rolls the whole activation back, so
  // a phase can never sit in `active` without a job (which would stall
  // the phase forever). Concurrent activations lose the conditional
  // claim (0 rows) and roll back.
  return prisma.$transaction(async (t) => {
    const phase = await t.otaRolloutPhase.findUnique({
      where: { rolloutId_index: { rolloutId, index: phaseIndex } },
      select: { id: true, targetCount: true },
    });
    if (!phase) return false;

    const claimed = await t.otaRolloutPhase.updateMany({
      where: { id: phase.id, state: "pending" },
      data: { state: "active", activatedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    // devices = pool sorted by sort_idx, first targetCount (phase index is
    // cumulative: phases cover [0, t1), [t1, t1+t2), ...)
    const pool = await t.otaRolloutPool.findMany({
      where: { rolloutId },
      orderBy: { sortIdx: "asc" },
      select: { deviceId: true },
    });
    const prior = await t.otaRolloutPhase.aggregate({
      where: { rolloutId, index: { lt: phaseIndex } },
      _sum: { targetCount: true },
    });
    const start = prior._sum.targetCount ?? 0;
    const slice = pool.slice(start, start + phase.targetCount).map((p) => p.deviceId);

    const rollout = await t.otaRollout.findUniqueOrThrow({
      where: { id: rolloutId },
      select: { projectId: true, releaseId: true, createdBy: true },
    });
    const jobId = randomUUID();
    await t.otaJob.create({
      data: {
        id: jobId,
        projectId: rollout.projectId,
        releaseId: rollout.releaseId,
        createdBy: rollout.createdBy,
      },
    });
    await createTargetsForRelease(t, jobId, rollout.releaseId, slice, ttlMs);
    await t.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await t.otaRolloutPhase.update({
      where: { id: phase.id },
      data: { jobId },
    });
    return true;
  });
}

/** Pauses a rollout (stops advancing; in-flight deliveries are untouched). */
export async function pauseRollout(prisma: PrismaClient, rolloutId: string): Promise<boolean> {
  const result = await prisma.$transaction([
    prisma.otaRollout.updateMany({
      where: { id: rolloutId, state: "running" },
      data: { state: "paused" },
    }),
    prisma.otaRolloutPhase.updateMany({
      where: { rolloutId, state: "active" },
      data: { state: "paused" },
    }),
  ]);
  return result[0]!.count > 0;
}

/**
 * Resumes a rollout. Two wait states are covered:
 *   - `paused` (timeout / user pause): back to running, paused phases
 *     become active again
 *   - manual-approval wait (rollout running with no active phase): the
 *     next pending phase is activated immediately
 */
export async function resumeRollout(
  prisma: PrismaClient,
  rolloutId: string,
  targetTtlSeconds?: number,
): Promise<boolean> {
  const ttlMs = (targetTtlSeconds ?? DEFAULT_ROLLOUT_TARGET_TTL_SECONDS) * 1000;
  const rollout = await prisma.otaRollout.findUnique({
    where: { id: rolloutId },
    select: { state: true, projectId: true },
  });
  if (!rollout || rollout.state === "aborted" || rollout.state === "completed") return false;
  if (rollout.state === "paused") {
    await prisma.otaRollout.updateMany({
      where: { id: rolloutId, state: "paused" },
      data: { state: "running" },
    });
    await prisma.otaRolloutPhase.updateMany({
      where: { rolloutId, state: "paused" },
      data: { state: "active", activatedAt: new Date() },
    });
    await notifyRolloutEvent(prisma, "resumed", rolloutId, rollout.projectId);
    return true;
  }
  // manual-approval wait (rollout running, nothing active): activate the
  // next pending phase. Guarded: a running rollout with an active phase
  // must not get its next phase force-activated via resume — that would
  // bypass the success gate (and double-activate two phases).
  const active = await prisma.otaRolloutPhase.findFirst({
    where: { rolloutId, state: "active" },
    select: { id: true },
  });
  if (active) return false;
  const next = await prisma.otaRolloutPhase.findFirst({
    where: { rolloutId, state: "pending" },
    orderBy: { index: "asc" },
  });
  if (next) {
    await activatePendingPhase(prisma, rolloutId, next.index, ttlMs);
    await notifyRolloutEvent(prisma, "resumed", rolloutId, rollout.projectId);
  }
  return true;
}

/** Aborts a rollout: stops advancing; delivered devices keep their firmware. */
export async function abortRollout(prisma: PrismaClient, rolloutId: string): Promise<boolean> {
  const result = await prisma.otaRollout.updateMany({
    where: { id: rolloutId, state: { in: ["running", "paused"] } },
    data: { state: "aborted" },
  });
  if (result.count === 0) return false;
  // project id for the notification (best-effort; the update above
  // already committed)
  const notify = await prisma.otaRollout
    .findUnique({ where: { id: rolloutId }, select: { projectId: true } })
    .catch(() => null);
  if (notify) {
    await notifyRolloutEvent(prisma, "aborted", rolloutId, notify.projectId);
  }
  await prisma.otaRolloutPhase.updateMany({
    where: { rolloutId, state: "active" },
    data: { state: "paused" },
  });
  // pending phases stay pending on purpose: the advance loop only scans
  // `running` rollouts, so an aborted rollout can never activate them —
  // keeping the rows preserves the audit trail without a phase-level
  // `aborted` state (proposal 19 leaves phase states at 4 values).
  return true;
}

export interface RollbackResult {
  rollbackJobId: string;
  targetDevices: number;
}

/**
 * Rollback: aborts the rollout and creates a plain ota_job for
 * from_release_id targeting the devices that CONFIRMED the upgrade
 * (state=completed). Devices in `installed` are intentionally excluded
 * (they may be mid-reboot/bricked — human intervention).
 */
export async function rollbackRollout(
  prisma: PrismaClient,
  rolloutId: string,
  targetTtlSeconds?: number,
): Promise<RollbackResult> {
  const ttlMs = (targetTtlSeconds ?? DEFAULT_ROLLOUT_TARGET_TTL_SECONDS) * 1000;
  const rollout = await prisma.otaRollout.findUnique({
    where: { id: rolloutId },
    select: {
      id: true,
      fromReleaseId: true,
      projectId: true,
      createdBy: true,
      phases: { select: { jobId: true } },
    },
  });
  if (!rollout) throw new OtaError("not_found", "rollout does not exist");
  if (!rollout.fromReleaseId) {
    throw new OtaError("rollback_unavailable", "rollout has no from_release_id");
  }

  // idempotency: a previous rollback's job is reused while it is still
  // live. Once every target is terminal (the delivery window fully
  // elapsed), a fresh rollback is allowed — that is the post-window
  // re-trigger path (proposal 19 §5b).
  let terminalOldJobId: string | null = null;
  const existing = await prisma.otaRollout.findUnique({
    where: { id: rolloutId },
    select: { rollbackJobId: true },
  });
  if (existing?.rollbackJobId) {
    const targets = await prisma.otaTarget.findMany({
      where: { jobId: existing.rollbackJobId },
      select: { state: true },
    });
    const allTerminal =
      targets.length > 0 && targets.every((t) => t.state === "failed" || t.state === "expired");
    if (!allTerminal) {
      return { rollbackJobId: existing.rollbackJobId, targetDevices: targets.length };
    }
    // fall through: old job fully terminal, build a fresh rollback and
    // allow the claim to overwrite the stale job id
    terminalOldJobId = existing.rollbackJobId;
  }

  const deviceIds = await prisma.otaTarget.findMany({
    where: {
      jobId: { in: rollout.phases.map((p) => p.jobId).filter((j): j is string => j !== null) },
      state: "completed",
    },
    select: { deviceId: true },
  });
  if (deviceIds.length === 0) {
    throw new OtaError("rollback_unavailable", "no devices confirmed the upgrade");
  }

  // Atomic claim of the rollback slot: the conditional update wins for
  // exactly one caller (concurrent rollbacks each build their own job,
  // the loser deletes it and returns the winner's). `rollbackJobId`
  // starts null and is only ever set here, so the WHERE is the lock.
  const jobId = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.otaJob.create({
        data: {
          id: jobId,
          projectId: rollout.projectId,
          releaseId: rollout.fromReleaseId!,
          createdBy: rollout.createdBy,
        },
      });
      await createTargetsForRelease(
        tx,
        jobId,
        rollout.fromReleaseId!,
        deviceIds.map((device) => device.deviceId),
        ttlMs,
      );
      const claimed = await tx.otaRollout.updateMany({
        where: terminalOldJobId
          ? {
              id: rolloutId,
              OR: [{ rollbackJobId: null }, { rollbackJobId: terminalOldJobId }],
            }
          : { id: rolloutId, rollbackJobId: null },
        data: { state: "aborted", rollbackJobId: jobId },
      });
      if (claimed.count === 0) {
        // lost the race (or a live rollback already exists): drop our
        // orphan job and hand back the winner's result
        await tx.otaTarget.deleteMany({ where: { jobId } });
        await tx.otaJob.deleteMany({ where: { id: jobId } });
        const winner = await tx.otaRollout.findUniqueOrThrow({
          where: { id: rolloutId },
          select: { rollbackJobId: true },
        });
        if (!winner.rollbackJobId) {
          throw new Error("rollback claim lost without a winner (unreachable)");
        }
        return winner.rollbackJobId;
      }
      await tx.otaRolloutPhase.updateMany({
        where: { rolloutId, state: "active" },
        data: { state: "paused" },
      });
      await tx.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
      return jobId;
    });
  } catch (error) {
    throw new OtaError("database", `rollback failed: ${(error as Error).message}`);
  }
  const finalJobId =
    (await prisma.otaRollout.findUniqueOrThrow({
      where: { id: rolloutId },
      select: { rollbackJobId: true },
    })).rollbackJobId ?? jobId;
  const count = await prisma.otaTarget.count({
    where: { jobId: finalJobId },
  });
  return { rollbackJobId: finalJobId, targetDevices: count };
}
