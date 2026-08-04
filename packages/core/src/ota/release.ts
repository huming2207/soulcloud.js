/**
 * OTA firmware releases: the distributable unit is a bin image (required),
 * optionally tied to an ELF artifact for build identity (device `stat.fw`
 * reports the ELF hash) and on9log decoding.
 *
 * Download authorization uses single-use, short-lived tokens: a project
 * member trades a release id for a 3-minute credential; the download
 * endpoint consumes it atomically (see llm-docs/soulcloudjs/16-ota-firmware-releases-proposal.md).
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../db";
import { ArtifactImportError, importArtifact, isUniqueViolation } from "../logging/artifact";

/** Maximum accepted bin/ELF size (32MB, same as ELF artifacts). */
export const MAX_FIRMWARE_BYTES = 32 * 1024 * 1024;

/** Default download token lifetime (seconds). */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 180;

export class ReleaseError extends Error {
  constructor(
    public readonly kind: "invalid_bin" | "too_large" | "database",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** Returns the SHA-256 hex digest of a bin image (exact image identity). */
export function computeBinHash(bin: Uint8Array): string {
  return createHash("sha256").update(bin).digest("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CreateReleaseOptions {
  projectId: string;
  /** Bin image (required — a release without a distributable image is meaningless). */
  bin: Uint8Array;
  /** Optional ELF for build identity / log decoding (imported idempotently). */
  elf?: Uint8Array;
  /** Human-readable version label (reference only, never identity). */
  version?: string;
}

export interface CreatedRelease {
  releaseId: string;
  binHash: string;
  binSize: number;
  artifactId: string | null;
  version: string | null;
  /** true when the bin already existed (idempotent re-upload). */
  existed: boolean;
}

/**
 * Creates a firmware release: imports the optional ELF (idempotent), then
 * stores the bin with SHA-256 identity. Re-uploading the same bin in the
 * same project returns the existing release (idempotent).
 *
 * @throws {ArtifactImportError} (invalid ELF) or {ReleaseError}.
 */
export async function createFirmwareRelease(
  prisma: PrismaClient,
  options: CreateReleaseOptions,
): Promise<CreatedRelease> {
  if (options.bin.byteLength === 0) {
    throw new ReleaseError("invalid_bin", "bin is empty");
  }
  if (options.bin.byteLength > MAX_FIRMWARE_BYTES) {
    throw new ReleaseError("too_large", `bin exceeds ${MAX_FIRMWARE_BYTES} bytes`);
  }
  const binHash = computeBinHash(options.bin);

  let artifactId: string | null = null;
  if (options.elf) {
    try {
      const imported = await importArtifact(prisma, {
        projectId: options.projectId,
        elf: options.elf,
        version: options.version,
      });
      artifactId = imported.artifactId;
    } catch (error) {
      if (error instanceof ArtifactImportError) throw error;
      throw new ReleaseError(
        "database",
        `artifact import failed: ${(error as Error).message}`,
      );
    }
  }

  const version = options.version ?? null;
  try {
    return await prisma.$transaction(async (tx) => {
      // M3-style: identity is unique per project, never global across tenants
      const existing = await tx.firmwareRelease.findUnique({
        where: { projectId_binHash: { projectId: options.projectId, binHash } },
        select: { id: true, artifactId: true, binSize: true, version: true },
      });
      if (existing) {
        return {
          releaseId: existing.id,
          binHash,
          binSize: existing.binSize,
          artifactId: existing.artifactId,
          version: existing.version,
          existed: true,
        };
      }
      const release = await tx.firmwareRelease.create({
        data: {
          projectId: options.projectId,
          artifactId,
          binHash,
          binBytes: Buffer.from(options.bin),
          binSize: options.bin.byteLength,
          version,
        },
        select: { id: true },
      });
      return {
        releaseId: release.id,
        binHash,
        binSize: options.bin.byteLength,
        artifactId,
        version,
        existed: false,
      };
    });
  } catch (error) {
    // concurrent upload of the same bin races the unique index; the loser
    // returns the idempotent existing row
    if (isUniqueViolation(error)) {
      const existing = await prisma.firmwareRelease.findUnique({
        where: { projectId_binHash: { projectId: options.projectId, binHash } },
        select: { id: true, artifactId: true, binSize: true, version: true },
      });
      if (existing) {
        return {
          releaseId: existing.id,
          binHash,
          binSize: existing.binSize,
          artifactId: existing.artifactId,
          version: existing.version,
          existed: true,
        };
      }
    }
    throw new ReleaseError(
      "database",
      `release creation failed: ${(error as Error).message}`,
    );
  }
}

export interface DownloadTokenResult {
  /** The credential itself (returned once; only its digest is stored). */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a single-use download credential for a release's bin. Expired
 * tokens of the same release are lazily purged (the table stays tiny).
 */
export async function createDownloadToken(
  prisma: PrismaClient,
  releaseId: string,
  ttlSeconds: number = DOWNLOAD_TOKEN_TTL_SECONDS,
): Promise<DownloadTokenResult> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await prisma.$transaction(async (tx) => {
    await tx.firmwareDownloadToken.deleteMany({
      where: { releaseId, expiresAt: { lt: new Date() } },
    });
    await tx.firmwareDownloadToken.create({
      data: { releaseId, tokenHash, expiresAt },
    });
  });
  return { token, expiresAt };
}

/**
 * Atomically consumes a download credential. The UPDATE's
 * `used_at IS NULL` predicate makes single-use safe under concurrency:
 * only one request can flip the row. Returns false for invalid, expired,
 * already-used or release-mismatched tokens (indistinguishable on purpose).
 */
export async function consumeDownloadToken(
  prisma: PrismaClient,
  releaseId: string,
  token: string,
): Promise<boolean> {
  const now = new Date();
  const result = await prisma.firmwareDownloadToken.updateMany({
    where: { releaseId, tokenHash: sha256Hex(token), usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return result.count === 1;
}
