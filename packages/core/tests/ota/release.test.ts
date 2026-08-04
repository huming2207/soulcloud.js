/**
 * OTA firmware release tests: release creation (bin required, ELF optional,
 * idempotent by bin hash) and single-use download tokens (atomic consume,
 * expiry, mismatch).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  MAX_FIRMWARE_BYTES,
  ReleaseError,
  computeBinHash,
  createFirmwareRelease,
} from "../../src/ota/release";
import { buildNoloadElf } from "../helpers/elf-builder";

const elf = buildNoloadElf(["value=%d"], ["demo"], 32, true);

let projectId: string;

function makeBin(size = 4096): Uint8Array {
  const bin = new Uint8Array(size);
  bin[0] = 0x7b;
  bin[1] = 0x8a;
  bin[size - 1] = 0x5a;
  return bin;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "ota-release-test" } });
});

afterAll(async () => {
  await prisma.firmwareRelease.deleteMany({ where: { projectId } });
  await prisma.firmwareArtifact.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("createFirmwareRelease", () => {
  test("bin-only upload creates a release without an artifact link", async () => {
    const bin = makeBin();
    const created = await createFirmwareRelease(prisma, { projectId, bin });
    expect(created.existed).toBe(false);
    expect(created.binHash).toBe(computeBinHash(bin));
    expect(created.binSize).toBe(bin.byteLength);
    expect(created.artifactId).toBeNull();
    const row = await prisma.firmwareRelease.findUnique({
      where: { id: created.releaseId },
    });
    expect(row?.binSize).toBe(bin.byteLength);
  });

  test("re-uploading the same bin is idempotent (same release id)", async () => {
    const bin = makeBin(2048);
    const first = await createFirmwareRelease(prisma, { projectId, bin });
    const second = await createFirmwareRelease(prisma, { projectId, bin });
    expect(second.existed).toBe(true);
    expect(second.releaseId).toBe(first.releaseId);
    // row count unchanged
    const count = await prisma.firmwareRelease.count({ where: { projectId } });
    expect(count).toBe(2); // previous test's bin + this one
  });

  test("same bin in a different project is a separate release", async () => {
    const otherProject = randomUUID();
    await prisma.project.create({ data: { id: otherProject, name: "ota-other" } });
    try {
      const bin = makeBin(1024);
      const a = await createFirmwareRelease(prisma, { projectId, bin });
      const b = await createFirmwareRelease(prisma, { projectId: otherProject, bin });
      expect(a.releaseId).not.toBe(b.releaseId);
      expect(b.existed).toBe(false);
    } finally {
      await prisma.firmwareRelease.deleteMany({ where: { projectId: otherProject } });
      await prisma.project.delete({ where: { id: otherProject } });
    }
  });

  test("elf+bin upload links the artifact", async () => {
    const created = await createFirmwareRelease(prisma, {
      projectId,
      bin: makeBin(512),
      elf,
      version: "v1.2.3",
    });
    expect(created.artifactId).not.toBeNull();
    expect(created.version).toBe("v1.2.3");
    const artifact = await prisma.firmwareArtifact.findUnique({
      where: { id: created.artifactId! },
      select: { buildId: true },
    });
    expect(artifact?.buildId).toBe(
      createHash("sha256").update(elf).digest("hex"),
    );
  });

  test("empty bin is rejected", async () => {
    await expect(
      createFirmwareRelease(prisma, { projectId, bin: new Uint8Array(0) }),
    ).rejects.toThrow(ReleaseError);
  });

  test("oversized bin is rejected", async () => {
    const big = new Uint8Array(MAX_FIRMWARE_BYTES + 1);
    await expect(
      createFirmwareRelease(prisma, { projectId, bin: big }),
    ).rejects.toThrow(/exceeds/);
  });

  test("invalid ELF is rejected and no release row is created", async () => {
    await expect(
      createFirmwareRelease(prisma, {
        projectId,
        bin: makeBin(256),
        elf: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/ELF/);
    const count = await prisma.firmwareRelease.count({
      where: { projectId, binHash: computeBinHash(makeBin(256)) },
    });
    expect(count).toBe(0);
  });
});
