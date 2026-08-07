/**
 * P2: render-failure behaviour consistency between the single-event and
 * batch decode paths (Kimi audit note; packages/core/src/logging/decode.ts).
 *
 * This file FIXES THE CURRENT BEHAVIOUR — it documents the existing
 * inconsistency, it does not change decode.ts:
 *
 *   - decodeRawEvent      (single path)  returns { message: null, tag }   on
 *     render failure (the tag survives)
 *   - decodeEventsBatch   (batch path)   returns { tag: null, message: null }
 *     on render failure (the tag is dropped)
 *
 * The tests below assert exactly that asymmetry so the difference is
 * visible and locked in until someone reconciles the two paths in decode.ts
 * (at which point BOTH tests must be updated together).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  On9logPacketType,
  decodeRawEvent,
  decodeEventsBatch,
  prisma,
  type RawEventForDecode,
} from "@soulcloud/core";

// dictionary layout: "demo" tag at TAG_ADDR, "value=%d" format at FMT_ADDR
const TAG_ADDR = 0x40000000;
const FMT_ADDR = 0x40000005;

let projectId: string;
let artifactId: string;

function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

/** A LOG packet with the given tag/fmt addresses and args (streaming). */
function logPacket(
  tagId: number,
  fmtId: number,
  argTypes: number[],
  argBytes: number[],
): Uint8Array {
  return new Uint8Array([
    0x9a, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...le32(tagId), ...le32(fmtId), 0xff, 0xff,
    argTypes.length, ...argTypes, ...argBytes,
  ]);
}

function event(rawPacket: Uint8Array): RawEventForDecode {
  return {
    id: 1n,
    artifactId,
    packetType: On9logPacketType.Log,
    tagId: BigInt(TAG_ADDR),
    fmtId: BigInt(FMT_ADDR),
    rawPacket,
  };
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "decode-consistency" } });
  const artifact = await prisma.firmwareArtifact.create({
    data: {
      id: randomUUID(),
      projectId,
      buildId: `dc-${randomUUID()}`,
      elfSize: 4,
      elfBytes: Buffer.from([1, 2, 3, 4]),
      importState: "imported",
    },
  });
  artifactId = artifact.id;
  await prisma.firmwareLogString.createMany({
    data: [
      { artifactId, address: BigInt(TAG_ADDR), kind: "tag", value: "demo" },
      { artifactId, address: BigInt(FMT_ADDR), kind: "format", value: "value=%d" },
    ],
  });
});

afterAll(async () => {
  await prisma.firmwareLogString.deleteMany({ where: { artifactId } });
  await prisma.firmwareArtifact.deleteMany({ where: { id: artifactId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("decode render-failure behaviour (current state)", () => {
  test("a matching packet renders identically on both paths", async () => {
    const ok = event(logPacket(TAG_ADDR, FMT_ADDR, [1], le32(7))); // "value=7"
    const single = await decodeRawEvent(prisma, ok);
    expect(single).toEqual({ message: "value=7", tag: "demo" });
    const batch = await decodeEventsBatch(prisma, [ok]);
    expect(batch).toEqual([{ message: "value=7", tag: "demo" }]);
  });

  test("single path keeps the tag when rendering fails", async () => {
    // fmt "value=%d" with zero args -> renderFormat throws; the single
    // path reports { message: null, tag: "demo" }
    const bad = event(logPacket(TAG_ADDR, FMT_ADDR, [], []));
    const decoded = await decodeRawEvent(prisma, bad);
    expect(decoded.message).toBeNull();
    expect(decoded.tag).toBe("demo");
  });

  test("batch path drops the tag when rendering fails (current inconsistency)", async () => {
    // same input as above; the batch path reports { tag: null, message: null }
    const bad = event(logPacket(TAG_ADDR, FMT_ADDR, [], []));
    const decoded = await decodeEventsBatch(prisma, [bad]);
    expect(decoded).toEqual([{ tag: null, message: null }]);
  });

  test("dictionary gaps are reported consistently (tag null on both paths)", async () => {
    const orphan = event(logPacket(TAG_ADDR, FMT_ADDR, [], []));
    orphan.artifactId = null;
    expect(await decodeRawEvent(prisma, orphan)).toEqual({ message: null, tag: null });
    expect(await decodeEventsBatch(prisma, [orphan])).toEqual([
      { message: null, tag: null },
    ]);
  });
});
