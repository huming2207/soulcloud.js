/**
 * P2: render-failure behaviour consistency between the single-event and
 * batch decode paths (Kimi audit note; packages/core/src/logging/decode.ts).
 *
 * Both paths are unified to KEEP THE TAG on render failure:
 *
 *   - decodeRawEvent      (single path)  returns { message: null, tag }
 *   - decodeEventsBatch   (batch path)   returns { tag, message: null }
 *
 * The tag survives because it has dictionary-address audit value even when
 * the message cannot be rendered. The tests below assert the unified
 * behaviour on both paths.
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  On9logPacketType,
  clearDictionaryCache,
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

describe("decode render-failure behaviour (tag preserved on both paths)", () => {
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

  test("batch path keeps the tag when rendering fails (unified)", async () => {
    // same input as above; the batch path reports { tag: "demo", message: null }
    const bad = event(logPacket(TAG_ADDR, FMT_ADDR, [], []));
    const decoded = await decodeEventsBatch(prisma, [bad]);
    expect(decoded).toEqual([{ tag: "demo", message: null }]);
  });

  test("dictionary gaps are reported consistently (tag null on both paths)", async () => {
    const orphan = event(logPacket(TAG_ADDR, FMT_ADDR, [], []));
    orphan.artifactId = null;
    expect(await decodeRawEvent(prisma, orphan)).toEqual({ message: null, tag: null });
    expect(await decodeEventsBatch(prisma, [orphan])).toEqual([
      { message: null, tag: null },
    ]);
  });

  test("unparsable packets keep the tag on both paths (unified)", async () => {
    // garbage bytes that fail parseOn9logPacket; the tag address is known
    // from the dictionary, so both paths keep it
    const junk = event(new Uint8Array([0x01, 0x02, 0x03]));
    expect(await decodeRawEvent(prisma, junk)).toEqual({ message: null, tag: "demo" });
    expect(await decodeEventsBatch(prisma, [junk])).toEqual([
      { message: null, tag: "demo" },
    ]);
  });
});

describe("artifact dictionary cache (decodeEventsBatch)", () => {
  test("caches the dictionary: a second batch does not re-query it", async () => {
    clearDictionaryCache();
    const original = prisma.firmwareLogString.findMany;
    const calls: unknown[] = [];
    prisma.firmwareLogString.findMany = ((...args: unknown[]) => {
      calls.push(args);
      return original(...(args as Parameters<typeof original>));
    }) as typeof prisma.firmwareLogString.findMany;
    try {
      const ok = event(logPacket(TAG_ADDR, FMT_ADDR, [1], le32(7))); // "value=7"
      expect(await decodeEventsBatch(prisma, [ok, ok])).toEqual([
        { message: "value=7", tag: "demo" },
        { message: "value=7", tag: "demo" },
      ]);
      expect(calls.length).toBe(1); // one query for both events (same artifact)
      // second batch: cache hit, no new query
      expect(await decodeEventsBatch(prisma, [ok])).toEqual([
        { message: "value=7", tag: "demo" },
      ]);
      expect(calls.length).toBe(1);
    } finally {
      prisma.firmwareLogString.findMany = original;
    }
  });

  test("the cache expires after the TTL and re-queries", async () => {
    clearDictionaryCache();
    const original = prisma.firmwareLogString.findMany;
    const calls: unknown[] = [];
    prisma.firmwareLogString.findMany = ((...args: unknown[]) => {
      calls.push(args);
      return original(...(args as Parameters<typeof original>));
    }) as typeof prisma.firmwareLogString.findMany;
    try {
      const ok = event(logPacket(TAG_ADDR, FMT_ADDR, [1], le32(7)));
      await decodeEventsBatch(prisma, [ok]);
      expect(calls.length).toBe(1);
      // advance the clock past the 60s TTL
      setSystemTime(new Date(Date.now() + 61_000));
      try {
        await decodeEventsBatch(prisma, [ok]);
        expect(calls.length).toBe(2);
      } finally {
        setSystemTime();
      }
    } finally {
      prisma.firmwareLogString.findMany = original;
    }
  });

  test("dictionaries are isolated per artifact", async () => {
    clearDictionaryCache();
    const original = prisma.firmwareLogString.findMany;
    const calls: unknown[] = [];
    prisma.firmwareLogString.findMany = ((...args: unknown[]) => {
      calls.push(args);
      return original(...(args as Parameters<typeof original>));
    }) as typeof prisma.firmwareLogString.findMany;
    try {
      const e1 = event(logPacket(TAG_ADDR, FMT_ADDR, [1], le32(7)));
      const e2 = { ...e1, artifactId: null };
      // second artifact (null) is not a dictionary artifact at all
      await decodeEventsBatch(prisma, [e1, e1]);
      await decodeEventsBatch(prisma, [e2]);
      expect(calls.length).toBe(1); // only the real artifact queried once
    } finally {
      prisma.firmwareLogString.findMany = original;
    }
  });
});
