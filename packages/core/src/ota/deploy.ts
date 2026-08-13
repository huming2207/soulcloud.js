/**
 * OTA deployment: user-initiated jobs fan out per-device download
 * credentials over MQTT (devices fetch the bin over HTTP themselves).
 *
 * The download credential is a short-lived, per-device JWT (HS256):
 *
 *   - claims: sub = device UID (identity binding), releaseId, exp
 *   - no usage limit (stateless by design; download retries / resume need
 *     repeated access — the short expiry is the security boundary)
 *   - never stored (self-contained); ota_targets only tracks the delivery
 *     state machine: pending → leased → delivered, or → expired when the
 *     delivery window passes
 *
 * Delivery itself is the broker's job (see packages/broker/src/mqtt/ota-publish.ts):
 * targets are the durable outbox, PostgreSQL LISTEN/NOTIFY is the lossy
 * wake-up, and the poll interval is the correctness fallback.
 */

import { randomUUID } from "node:crypto";
import { createSigner, createVerifier } from "fast-jwt";
import type { PrismaClient } from "../db";
import { OTA_NOTIFY_CHANNEL } from "../queue/notify";

/** Maximum number of target devices per OTA job (same as command batches). */
export const MAX_OTA_TARGETS = 1000;

/** Rows expired per maintenance batch (bounded row locks). */
const EXPIRY_BATCH_SIZE = 1000;

export class OtaError extends Error {
  constructor(
    public readonly kind:
      | "empty_targets"
      | "duplicate_targets"
      | "too_many_targets"
      | "target_not_found"
      | "target_not_in_project"
      | "release_not_in_project"
      | "invalid_ratios"
      | "invalid_from_release"
      | "no_phases"
      | "groups_overlap"
      | "not_found"
      | "rollback_unavailable"
      | "database",
    message: string,
  ) {
    super(message);
    this.name = "OtaError";
  }
}

export interface OtaTokenPayload {
  /** Device UID (identity binding: the token is device-scoped). */
  deviceUid: string;
  /** Release the token may download. */
  releaseId: string;
  /** Job the token belongs to (precise target lookup). */
  jobId: string;
}

/** Audience for OTA download credentials (audit M5: token class separation). */
export const OTA_TOKEN_AUDIENCE = "ota-download";

/**
 * Signer/verifier caches (perf): the broker mints one token per published
 * notice and the API verifies one per device download, so instances are
 * reused instead of rebuilt per call. Key includes the TTL for the signer
 * (expiresIn is baked in at creation; see auth/tokens.ts).
 */
type OtaSigner = (payload: Record<string, unknown>) => string;
type OtaVerifier = (token: string) => unknown;

const otaSigners = new Map<string, OtaSigner>();
const otaVerifiers = new Map<string, OtaVerifier>();

/** Signs a per-device OTA download credential (HS256, short-lived). */
export async function signOtaToken(
  secret: string,
  payload: OtaTokenPayload,
  ttlSeconds: number,
): Promise<string> {
  const cacheKey = `${secret}:${ttlSeconds}`;
  let signer = otaSigners.get(cacheKey);
  if (!signer) {
    signer = createSigner({
      key: secret,
      algorithm: "HS256",
      // fast-jwt interprets numeric expiresIn as MILLISECONDS
      expiresIn: ttlSeconds * 1000,
      aud: OTA_TOKEN_AUDIENCE,
    });
    otaSigners.set(cacheKey, signer);
  }
  return signer({
    sub: payload.deviceUid,
    releaseId: payload.releaseId,
    jobId: payload.jobId,
  });
}

/**
 * Verifies an OTA download credential. Returns null for any failure
 * (bad signature, expired, malformed claims) — the download endpoint
 * does not distinguish reasons.
 */
export async function verifyOtaToken(
  secret: string,
  token: string,
): Promise<OtaTokenPayload | null> {
  let verifier = otaVerifiers.get(secret);
  if (!verifier) {
    verifier = createVerifier({
      key: secret,
      algorithms: ["HS256"],
      allowedAud: OTA_TOKEN_AUDIENCE,
      // see tokens.ts: fast-jwt skips allowedAud without an aud claim;
      // jose rejected it. Require the claims explicitly.
      requiredClaims: ["aud", "exp", "releaseId", "jobId"],
    });
    otaVerifiers.set(secret, verifier);
  }
  try {
    const payload = verifier(token) as Record<string, unknown>;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.releaseId !== "string" ||
      typeof payload.jobId !== "string"
    ) {
      return null;
    }
    return { deviceUid: payload.sub, releaseId: payload.releaseId, jobId: payload.jobId };
  } catch {
    return null;
  }
}

export interface CreateOtaJobOptions {
  projectId: string;
  releaseId: string;
  createdBy: string;
  deviceIds: string[];
  /** Delivery window in seconds (a target not delivered by then expires). */
  targetTtlSeconds: number;
}

export interface OtaJobTarget {
  deviceId: string;
  deviceUid: string;
  /** "pending" normally; "completed" when the fast path confirmed the
   *  device is already running this release's firmware. */
  state: "pending" | "completed";
}

export interface CreatedOtaJob {
  jobId: string;
  targets: OtaJobTarget[];
}

/**
 * Returns the firmware identity used by the current OTA state machine for a
 * release. Keeping this lookup shared prevents direct deployments and
 * rollout-created jobs from disagreeing about whether a device already runs
 * the target.
 *
 * This deliberately preserves the existing release contract (artifact build
 * id when present, otherwise bin hash). Replacing that contract with a
 * verified runtime image identity is a separate migration.
 */
export async function resolveReleaseExpectedFirmware(
  prisma: Pick<PrismaClient, "firmwareRelease" | "firmwareArtifact">,
  releaseId: string,
): Promise<string | null> {
  const release = await prisma.firmwareRelease.findUnique({
    where: { id: releaseId },
    select: { artifactId: true, binHash: true },
  });
  if (!release) return null;
  if (!release.artifactId) return release.binHash;
  const artifact = await prisma.firmwareArtifact.findUnique({
    where: { id: release.artifactId },
    select: { buildId: true },
  });
  return artifact?.buildId ?? null;
}

/**
 * Creates an OTA job with one pending target per device, then wakes the
 * broker (lossy hint; the poll interval is the correctness fallback).
 *
 * All targets must exist and belong to the release's project; otherwise the
 * whole job is rejected (explicit-target semantics, like command batches).
 *
 * Re-deploying the same release to the same devices is allowed: each call
 * creates a fresh job. Targets whose device firmware state already matches
 * the release are created as `completed` immediately (fast path) — the
 * device already runs this build, so there is nothing to deliver; the
 * device-side dedupe would otherwise ignore the notice and the job could
 * never reach a terminal state.
 *
 * @throws {OtaError}
 */
export async function createOtaJob(
  prisma: PrismaClient,
  options: CreateOtaJobOptions,
): Promise<CreatedOtaJob> {
  if (options.deviceIds.length === 0) {
    throw new OtaError("empty_targets", "an OTA job must target at least one device");
  }
  if (new Set(options.deviceIds).size !== options.deviceIds.length) {
    throw new OtaError("duplicate_targets", "an OTA job contains duplicate device IDs");
  }
  if (options.deviceIds.length > MAX_OTA_TARGETS) {
    throw new OtaError("too_many_targets", "the OTA job contains too many target devices");
  }

  // the release must belong to the job's project (defense in depth; the API
  // already checks membership)
  const release = await prisma.firmwareRelease.findUnique({
    where: { id: options.releaseId },
    select: { projectId: true, artifactId: true, binHash: true },
  });
  if (!release || release.projectId !== options.projectId) {
    throw new OtaError(
      "release_not_in_project",
      "release does not belong to this project",
    );
  }

  const devices = await prisma.device.findMany({
    where: { id: { in: options.deviceIds } },
    select: { id: true, deviceUid: true, projectId: true },
  });
  if (devices.length !== options.deviceIds.length) {
    throw new OtaError(
      "target_not_found",
      "one or more target devices do not exist",
    );
  }
  const wrongProject = devices.find((d) => d.projectId !== options.projectId);
  if (wrongProject) {
    throw new OtaError(
      "target_not_in_project",
      "one or more target devices do not belong to this project",
    );
  }

  const jobId = randomUUID();
  const expiresAt = new Date(Date.now() + options.targetTtlSeconds * 1000);

  // fast path: targets whose device already reports this release's firmware
  // identity (ELF build id when an artifact exists, bin hash otherwise) are
  // completed without delivering anything. The reported identity must match
  // the same rule as confirmOtaTargetByFirmware.
  const expectedFw = await resolveReleaseExpectedFirmware(prisma, options.releaseId);
  const alreadyRunning = new Set<string>();
  if (expectedFw) {
    const states = await prisma.deviceFirmwareState.findMany({
      where: { deviceId: { in: options.deviceIds }, fwHash: expectedFw },
      select: { deviceId: true },
    });
    for (const s of states) alreadyRunning.add(s.deviceId);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.otaJob.create({
        data: {
          id: jobId,
          projectId: options.projectId,
          releaseId: options.releaseId,
          createdBy: options.createdBy,
        },
      });
      await tx.otaTarget.createMany({
        data: devices.map((d) => ({ jobId, deviceId: d.id, expiresAt })),
      });
      if (alreadyRunning.size > 0) {
        await tx.otaTarget.updateMany({
          where: { jobId, deviceId: { in: [...alreadyRunning] }, state: "pending" },
          data: { state: "completed", confirmedAt: new Date(), resultCode: 0 },
        });
      }
      // wake broker processes (lossy hint only)
      await tx.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    });
  } catch (error) {
    throw new OtaError(
      "database",
      `OTA job creation failed: ${(error as Error).message}`,
    );
  }

  return {
    jobId,
    targets: devices.map((d) => ({
      deviceId: d.id,
      deviceUid: d.deviceUid,
      // fast-path targets were completed during creation; report the real
      // state instead of a blanket "pending"
      state: alreadyRunning.has(d.id) ? "completed" : "pending",
    })),
  };
}

/**
 * Moves targets whose delivery window has passed to the terminal `expired`
 * state. Only SAFE states are expired (audit fix, OTA round-4 #2):
 *
 *   - `pending`: never published — clearly dead
 *   - `leased` with an EXPIRED lease: no active publisher holds it anymore
 *     (a live lease means a publish is in flight; expiring it would race
 *     the publisher and produce false negatives — the device really
 *     upgraded but the target sits in `expired` forever)
 *
 * Runs in bounded batches (same rationale as expireDelayedCommands).
 */
export async function expireOtaTargets(prisma: PrismaClient): Promise<number> {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      UPDATE ota_targets
      SET state = 'expired', lease_expires_at = NULL
      WHERE id IN (
        SELECT id
        FROM ota_targets
        WHERE expires_at < now()
          AND (state = 'pending'
               OR (state = 'leased' AND lease_expires_at <= now()))
        LIMIT ${EXPIRY_BATCH_SIZE}
      )
    `;
    total += affected;
    if (affected < EXPIRY_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Platform-side stall timeout (OTA round-4 #1): a target that was
 * DELIVERED but never completed its download within the stall window is
 * failed with code -7. This closes the permanent-stuck state for the
 * common first-OTA case: devices running old firmware without ota-topic
 * support receive nothing (Aedes reports a successful publish even with
 * zero subscribers), so `delivered` would otherwise sit forever.
 *
 * `installed` is deliberately NOT stalled here: a device may legitimately
 * be powered off; judging it requires the active+firmware-mismatch signal
 * (rollout milestone, proposal 19 D6).
 */
export async function expireStalledOtaTargets(
  prisma: PrismaClient,
  stallMinutes: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const affected = await prisma.$executeRaw`
      UPDATE ota_targets
      SET state = 'failed',
          confirmed_at = now(),
          result_code = -7,
          result_message = 'download window timeout'
      WHERE id IN (
        SELECT id
        FROM ota_targets
        WHERE state IN ('delivered', 'delivering', 'downloaded')
          AND delivered_at < now() - make_interval(secs => ${stallMinutes * 60}::double precision)
        LIMIT ${EXPIRY_BATCH_SIZE}
      )
    `;
    total += affected;
    if (affected < EXPIRY_BATCH_SIZE) break;
  }
  return total;
}

export interface LeasedOtaTarget {
  id: string;
  jobId: string;
  deviceUid: string;
  releaseId: string;
  projectId: string;
  binHash: string;
  binSize: number;
  version: string | null;
}

/**
 * Claims the oldest eligible target (`FOR UPDATE SKIP LOCKED`; concurrent
 * broker processes never double-deliver). A leased target whose lease
 * expired is claimable again; a target past its delivery window is not.
 */
export async function leaseNextOtaTarget(
  prisma: PrismaClient,
  leaseDurationMs: number,
): Promise<LeasedOtaTarget | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        job_id: string;
        device_uid: string;
        release_id: string;
        project_id: string;
        bin_hash: string;
        bin_size: number;
        version: string | null;
      }>
    >`
      SELECT t.id, j.id AS job_id, d.device_uid, r.id AS release_id, r.project_id,
             r.bin_hash, r.bin_size, r.version
      FROM ota_targets t
      INNER JOIN devices d ON d.id = t.device_id
      INNER JOIN ota_jobs j ON j.id = t.job_id
      INNER JOIN firmware_releases r ON r.id = j.release_id
      WHERE t.available_at <= now()
        AND t.expires_at > now()
        AND (t.state = 'pending' OR (t.state = 'leased' AND t.lease_expires_at <= now()))
      ORDER BY t.created_at, t.id
      FOR UPDATE OF t SKIP LOCKED
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    await tx.$executeRaw`
      UPDATE ota_targets
      SET state = 'leased',
          lease_expires_at = now() + make_interval(secs => ${leaseDurationMs / 1000}::double precision)
      WHERE id = ${row.id}
    `;
    return {
      id: row.id,
      jobId: row.job_id,
      deviceUid: row.device_uid,
      releaseId: row.release_id,
      projectId: row.project_id,
      binHash: row.bin_hash,
      binSize: row.bin_size,
      version: row.version,
    };
  });
}

/** Marks a target delivered (the ota message was broker-accepted). */
export async function markOtaTargetDelivered(
  prisma: PrismaClient,
  targetId: string,
): Promise<void> {
  await prisma.otaTarget.updateMany({
    where: { id: targetId, state: "leased" },
    data: { state: "delivered", deliveredAt: new Date(), leaseExpiresAt: null },
  });
}

/** Returns a leased target to pending after a failed publish/offline skip. */
export async function releaseOtaTarget(
  prisma: PrismaClient,
  targetId: string,
  offlineRetryMs = 5_000,
): Promise<void> {
  await prisma.otaTarget.updateMany({
    where: { id: targetId, state: "leased" },
    data: {
      state: "pending",
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + offlineRetryMs),
    },
  });
}

/** Terminal target states (immutable once reached). */
const TERMINAL_OTA_STATES = ["completed", "failed"] as const;

/** Intermediate states that may still transition (delivered + successors). */
const OTA_RESULT_ACCEPTING_STATES = [
  "delivered",
  "delivering",
  "downloaded",
] as const;

/**
 * Marks a target as `delivering` when the device actually starts the HTTP
 * download (the download request is the strongest "device received the
 * notice" evidence). Idempotent: repeated downloads of an already
 * delivering target update nothing, and downloads themselves are never
 * blocked by state.
 */
export async function markOtaTargetDelivering(
  prisma: PrismaClient,
  jobId: string,
  deviceUid: string,
): Promise<number> {
  const device = await prisma.device.findUnique({
    where: { deviceUid },
    select: { id: true },
  });
  if (!device) return 0;
  const result = await prisma.otaTarget.updateMany({
    where: { jobId, deviceId: device.id, state: "delivered" },
    data: { state: "delivering" },
  });
  return result.count;
}

export interface RecordOtaResultInput {
  deviceUid: string;
  jobId: string;
  releaseId: string;
  state: "downloaded" | "installed" | "failed";
  code: number;
  message?: string;
}

/**
 * Records a device ota/result acknowledgement. Terminal states are
 * immutable: only intermediate targets transition, and the first
 * acknowledgement wins (QoS1 duplicates update nothing).
 *
 * - downloaded: delivered/delivering -> downloaded
 * - installed:  delivered/delivering/downloaded -> installed (awaiting
 *   run confirmation; completed is driven by stat.fw, see
 *   confirmOtaTargetByFirmware)
 * - failed:     delivered/delivering/downloaded -> failed (code < 0)
 *
 * @returns 1 when a target transitioned, 0 when ignored (unknown job,
 * terminal state, or replay).
 */
export async function recordOtaResult(
  prisma: PrismaClient,
  input: RecordOtaResultInput,
): Promise<number> {
  const device = await prisma.device.findUnique({
    where: { deviceUid: input.deviceUid },
    select: { id: true },
  });
  if (!device) return 0;

  // the target is located by job + device; the release must match the job's
  // release (release_id lives on ota_jobs, not ota_targets)
  const target = await prisma.otaTarget.findFirst({
    where: { jobId: input.jobId, deviceId: device.id },
    select: { id: true, job: { select: { releaseId: true } } },
  });
  if (!target || target.job.releaseId !== input.releaseId) return 0;

  if (input.state === "failed") {
    const result = await prisma.otaTarget.updateMany({
      where: { id: target.id, state: { in: [...OTA_RESULT_ACCEPTING_STATES] } },
      data: {
        state: "failed",
        confirmedAt: new Date(),
        resultCode: input.code < 0 ? input.code : -5, // failed requires a negative code
        resultMessage: input.message ?? null,
      },
    });
    return result.count;
  }

  const targetState = input.state === "installed" ? "installed" : "downloaded";
  const accepting =
    input.state === "installed"
      ? ["delivered", "delivering", "downloaded"]
      : ["delivered", "delivering"];
  const result = await prisma.otaTarget.updateMany({
    where: { id: target.id, state: { in: accepting } },
    data: {
      state: targetState,
      // installed_at feeds the rollout stall judgement (rollout proposal 19)
      ...(input.state === "installed" ? { installedAt: new Date() } : {}),
      // intermediate states carry no result fields (CHECK constraint)
    },
  });
  return result.count;
}

/**
 * stat.fw fallback (fact layer): when a device reports a firmware hash,
 * any of its non-terminal targets for that release are confirmed as
 * `completed` when the reported identity matches the release — the ELF
 * build id when the release has an artifact, otherwise the release's bin
 * hash (bin-only releases have no ELF to match, so the SHA-256 of the bin
 * is the only verifiable identity). This is the ONLY driver of `completed`
 * — the platform never guesses, it requires the reported firmware to
 * actually match the release (proposal 18, D6). Idempotent: terminal
 * targets are not touched.
 *
 * @returns the number of targets confirmed.
 */
export async function confirmOtaTargetByFirmware(
  prisma: PrismaClient,
  deviceId: string,
  fwHash: string,
): Promise<number> {
  const result = await prisma.$executeRaw`
    UPDATE ota_targets t
    SET state = 'completed',
        confirmed_at = now(),
        result_code = 0
    FROM ota_jobs j
    INNER JOIN firmware_releases r ON r.id = j.release_id
    LEFT JOIN firmware_artifacts a ON a.id = r.artifact_id
    WHERE t.job_id = j.id
      AND t.device_id = ${deviceId}
      AND t.state IN ('delivered', 'delivering', 'downloaded', 'installed')
      AND ((a.id IS NOT NULL AND a."buildId" = ${fwHash})
           OR (a.id IS NULL AND r.bin_hash = ${fwHash}))
  `;
  return result;
}
