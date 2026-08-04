/**
 * OTA firmware release tests: release creation (bin required, ELF optional,
 * idempotent by bin hash) and single-use download tokens (atomic consume,
 * expiry, mismatch).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  MAX_FIRMWARE_BYTES,
  ReleaseError,
  computeBinHash,
  consumeDownloadToken,
  createDownloadToken,
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

describe("download tokens", () => {
  let releaseId: string;
  beforeAll(async () => {
    const created = await createFirmwareRelease(prisma, {
      projectId,
      bin: makeBin(300),
    });
    releaseId = created.releaseId;
  });

  test("token is random, only its digest is stored", async () => {
    const { token, expiresAt } = await createDownloadToken(prisma, releaseId, 180);
    expect(token.length).toBeGreaterThan(20);
    const digest = createHash("sha256").update(token).digest("hex");
    const row = await prisma.firmwareDownloadToken.findFirst({
      where: { releaseId, tokenHash: digest },
    });
    expect(row).not.toBeNull();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    // the plaintext token must not appear in the DB
    const all = await prisma.firmwareDownloadToken.findMany({ where: { releaseId } });
    expect(all.some((r) => r.tokenHash === token)).toBe(false);
  });

  test("consume succeeds once, then refuses (single use)", async () => {
    const { token } = await createDownloadToken(prisma, releaseId, 180);
    expect(await consumeDownloadToken(prisma, releaseId, token)).toBe(true);
    expect(await consumeDownloadToken(prisma, releaseId, token)).toBe(false);
  });

  test("expired token is refused", async () => {
    const { token } = await createDownloadToken(prisma, releaseId, 180);
    // backdate the row past expiry
    await prisma.firmwareDownloadToken.updateMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeDownloadToken(prisma, releaseId, token)).toBe(false);
  });

  test("token cannot be consumed against another release", async () => {
    const other = await createFirmwareRelease(prisma, {
      projectId,
      bin: makeBin(301),
    });
    const { token } = await createDownloadToken(prisma, releaseId, 180);
    expect(await consumeDownloadToken(prisma, other.releaseId, token)).toBe(false);
    // ...but is still valid for its own release
    expect(await consumeDownloadToken(prisma, releaseId, token)).toBe(true);
  });

  test("random garbage token is refused", async () => {
    expect(await consumeDownloadToken(prisma, releaseId, randomBytes(32).toString("base64url"))).toBe(false);
  });

  test("lazy cleanup removes expired tokens of the release", async () => {
    const stale = await createDownloadToken(prisma, releaseId, 180);
    await prisma.firmwareDownloadToken.updateMany({
      where: { tokenHash: createHash("sha256").update(stale.token).digest("hex") },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });
    await createDownloadToken(prisma, releaseId, 180);
    const leftover = await prisma.firmwareDownloadToken.count({
      where: { releaseId, expiresAt: { lt: new Date() } },
    });
    expect(leftover).toBe(0);
  });
});
