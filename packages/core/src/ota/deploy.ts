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
import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "../db";
import { OTA_NOTIFY_CHANNEL } from "../queue/notify";

/** Maximum number of target devices per OTA job (same as command batches). */
export const MAX_OTA_TARGETS = 1000;

export class OtaError extends Error {
  constructor(
    public readonly kind:
      | "empty_targets"
      | "duplicate_targets"
      | "too_many_targets"
      | "target_not_found"
      | "target_not_in_project"
      | "release_not_in_project"
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
}

/** Signs a per-device OTA download credential (HS256, short-lived). */
export async function signOtaToken(
  secret: string,
  payload: OtaTokenPayload,
  ttlSeconds: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ releaseId: payload.releaseId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.deviceUid)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
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
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.releaseId !== "string") {
      return null;
    }
    return { deviceUid: payload.sub, releaseId: payload.releaseId };
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
  state: "pending";
}

export interface CreatedOtaJob {
  jobId: string;
  targets: OtaJobTarget[];
}

/**
 * Creates an OTA job with one pending target per device, then wakes the
 * broker (lossy hint; the poll interval is the correctness fallback).
 *
 * All targets must exist and belong to the release's project; otherwise the
 * whole job is rejected (explicit-target semantics, like command batches).
 *
 * Re-deploying the same release to the same devices is allowed: each call
 * creates a fresh job (devices deduplicate by release on their side).
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
    select: { projectId: true },
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
      state: "pending" as const,
    })),
  };
}

/**
 * Moves targets whose delivery window has passed to the terminal `expired`
 * state, releasing the lease if one was held.
 */
export async function expireOtaTargets(prisma: PrismaClient): Promise<number> {
  const result = await prisma.otaTarget.updateMany({
    where: { state: { in: ["pending", "leased"] }, expiresAt: { lt: new Date() } },
    data: { state: "expired", leaseExpiresAt: null },
  });
  return result.count;
}

export interface LeasedOtaTarget {
  id: string;
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
        device_uid: string;
        release_id: string;
        project_id: string;
        bin_hash: string;
        bin_size: number;
        version: string | null;
      }>
    >`
      SELECT t.id, d.device_uid, r.id AS release_id, r.project_id,
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
