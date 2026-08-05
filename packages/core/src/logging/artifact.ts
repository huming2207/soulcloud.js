/**
 * Firmware artifact import: parse an uploaded ELF and extract the on9log
 * tag/format string dictionary.
 *
 * Security: only recognized sections are scanned (`.noload_keep_in_elf.*`
 * for formats, allocated read-only sections for tags); DWARF/strings/symbol
 * tables are never imported (they can contain build-machine paths and
 * unrelated data). The ELF is parsed, never executed; every offset and
 * length is bounds-checked by the parser.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "../db";
import {
  parseElf,
  extractStrings,
  type ElfInfo,
} from "../elf/parser";

export class ArtifactImportError extends Error {
  constructor(
    public readonly kind: "invalid_elf" | "too_large" | "database",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactImportError";
  }
}

/** Maximum accepted ELF size (32MB). */
export const MAX_ELF_BYTES = 32 * 1024 * 1024;

/** Returns the SHA-256 hex digest of an ELF (exact build identity). */
export function computeBuildId(elf: Uint8Array): string {
  return createHash("sha256").update(elf).digest("hex");
}

/** Extracted dictionary entries for one artifact. */
export interface ExtractedStrings {
  tags: Array<{ addr: number; value: string }>;
  formats: Array<{ addr: number; value: string }>;
}

/**
 * Extracts the on9log string dictionary from an ELF.
 *
 * @throws {ArtifactImportError} with kind `invalid_elf` when the ELF cannot
 * be parsed or yields no usable strings.
 */
export function extractArtifactStrings(elf: Uint8Array): ExtractedStrings {
  let info: ElfInfo;
  try {
    info = parseElf(elf);
  } catch (error) {
    throw new ArtifactImportError(
      "invalid_elf",
      `ELF parse failed: ${(error as Error).message}`,
    );
  }

  const tags: Array<{ addr: number; value: string }> = [];
  const formats: Array<{ addr: number; value: string }> = [];

  for (const sec of info.sections) {
    if (sec.type === 8 /* SHT_NOBITS */) continue;
    const strings = extractStrings(info, elf, sec);
    if (strings.length === 0) continue;
    if (sec.name.startsWith(".noload_keep_in_elf") || sec.name === ".noload") {
      // formats (and possibly tags) live in no-load sections
      // (`.noload` is the output section name GNU ld/ESP-IDF 6.0 produce
      // when merging `.noload_keep_in_elf.*` inputs; on9log firmware built
      // with IDF 6.x therefore carries the strings in a `.noload` section)
      for (const s of strings) {
        // a no-load string is a format if it contains a conversion, else a tag
        if (s.value.includes("%") || s.value.includes("{")) {
          formats.push(s);
        } else {
          tags.push(s);
        }
      }
    } else if (
      // allocated read-only string sections can hold static tags
      (sec.flags & 2n) !== 0n && // SHF_ALLOC
      /^\.(rodata|data\.rel\.ro|rodata\.str|srodata)/.test(sec.name) &&
      !sec.name.includes(".noload")
    ) {
      for (const s of strings) {
        if (!s.value.includes("%") && !s.value.includes("{")) {
          tags.push(s);
        }
      }
    }
  }

  if (tags.length === 0 && formats.length === 0) {
    throw new ArtifactImportError(
      "invalid_elf",
      "ELF contains no on9log strings (.noload_keep_in_elf sections missing?)",
    );
  }
  return { tags, formats };
}

export interface ImportArtifactOptions {
  projectId: string;
  /** ELF bytes. */
  elf: Uint8Array;
  /** Optional human-readable version label. */
  version?: string;
}

export interface ImportedArtifact {
  artifactId: string;
  buildId: string;
  tagCount: number;
  formatCount: number;
}

/**
 * Uploads and imports a firmware artifact in one transaction:
 * hashes, stores the ELF, extracts the dictionary, marks imported.
 *
 * @throws {ArtifactImportError} on validation/parse/database failures.
 */
export async function importArtifact(
  prisma: PrismaClient,
  options: ImportArtifactOptions,
): Promise<ImportedArtifact> {
  if (options.elf.byteLength === 0) {
    throw new ArtifactImportError("invalid_elf", "ELF is empty");
  }
  if (options.elf.byteLength > MAX_ELF_BYTES) {
    throw new ArtifactImportError(
      "too_large",
      `ELF exceeds ${MAX_ELF_BYTES} bytes`,
    );
  }

  const buildId = computeBuildId(options.elf);

  // parse before touching the database so invalid ELFs never create rows
  let extracted: ExtractedStrings;
  try {
    extracted = extractArtifactStrings(options.elf);
  } catch (error) {
    if (error instanceof ArtifactImportError) throw error;
    throw new ArtifactImportError(
      "invalid_elf",
      `ELF extraction failed: ${(error as Error).message}`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // M3: idempotency is scoped per project (build identity is unique
      // per project, never global across tenants)
      const existing = await tx.firmwareArtifact.findUnique({
        where: { projectId_buildId: { projectId: options.projectId, buildId } },
        select: { id: true },
      });
      if (existing) {
        const counts = await tx.firmwareLogString.groupBy({
          by: ["kind"],
          where: { artifactId: existing.id },
          _count: true,
        });
        const tagCount = counts.find((c) => c.kind === "tag")?._count ?? 0;
        const formatCount = counts.find((c) => c.kind === "format")?._count ?? 0;
        return {
          artifactId: existing.id,
          buildId,
          tagCount,
          formatCount,
        };
      }

      const artifact = await tx.firmwareArtifact.create({
        data: {
          projectId: options.projectId,
          buildId,
          version: options.version ?? null,
          elfBytes: Buffer.from(options.elf),
          elfSize: options.elf.byteLength,
          importState: "imported",
        },
      });

      await tx.firmwareLogString.createMany({
        data: [
          ...extracted.tags.map((s) => ({
            artifactId: artifact.id,
            address: BigInt(s.addr),
            kind: "tag" as const,
            value: s.value,
          })),
          ...extracted.formats.map((s) => ({
            artifactId: artifact.id,
            address: BigInt(s.addr),
            kind: "format" as const,
            value: s.value,
          })),
        ],
      });

      return {
        artifactId: artifact.id,
        buildId,
        tagCount: extracted.tags.length,
        formatCount: extracted.formats.length,
      };
    });
  } catch (error) {
    // M1: concurrent uploads of the same build race the unique index; the
    // loser gets P2002 and should return the idempotent existing row
    if (isUniqueViolation(error)) {
      const existing = await prisma.firmwareArtifact.findUnique({
        where: { projectId_buildId: { projectId: options.projectId, buildId } },
        select: { id: true },
      });
      if (existing) {
        const counts = await prisma.firmwareLogString.groupBy({
          by: ["kind"],
          where: { artifactId: existing.id },
          _count: true,
        });
        return {
          artifactId: existing.id,
          buildId,
          tagCount: counts.find((c) => c.kind === "tag")?._count ?? 0,
          formatCount: counts.find((c) => c.kind === "format")?._count ?? 0,
        };
      }
    }
    throw new ArtifactImportError(
      "database",
      `artifact import failed: ${(error as Error).message}`,
    );
  }
}

/** Detects a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Backfills `decode_state='decodable'` (and the artifact link) for raw
 * events whose device's latest reported firmware matches `buildId`.
 *
 * Unknown-fw events were stored with `artifactId = null`; they become
 * decodable once the matching ELF is uploaded.
 */
export async function backfillDecodeState(
  prisma: PrismaClient,
  artifactId: string,
  buildId: string,
): Promise<number> {
  const artifact = await prisma.firmwareArtifact.findUnique({
    where: { id: artifactId },
    select: { projectId: true },
  });
  if (!artifact) return 0;
  // M3: only devices in the artifact's project can be linked (a buildId is
  // unique per project, so a cross-project match must not happen)
  const devices = await prisma.deviceFirmwareState.findMany({
    where: { fwHash: buildId, device: { projectId: artifact.projectId } },
    select: { deviceId: true },
  });
  if (devices.length === 0) return 0;
  const result = await prisma.rawLogEvent.updateMany({
    where: {
      decodeState: "unknown_fw",
      artifactId: null,
      deviceId: { in: devices.map((d) => d.deviceId) },
    },
    data: { decodeState: "decodable", artifactId },
  });
  return result.count;
}
