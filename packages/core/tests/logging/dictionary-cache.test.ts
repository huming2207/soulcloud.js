import { afterEach, expect, test } from "bun:test";
import { clearDictionaryCache, decodeEventsBatch, type RawEventForDecode } from "../../src/logging/decode";
import type { PrismaClient } from "../../src/db";

afterEach(clearDictionaryCache);

test("dictionary cache evicts entries even when all entries are still fresh", async () => {
  const queries: string[] = [];
  const prisma = { firmwareLogString: { findMany: async ({ where }: { where: { artifactId: string } }) => {
    queries.push(where.artifactId);
    return [];
  } } } as unknown as PrismaClient;
  const event = (artifactId: string): RawEventForDecode => ({
    id: 1n, artifactId, packetType: 0, tagId: null, fmtId: null, rawPacket: new Uint8Array(),
  });
  for (let i = 0; i < 201; i++) await decodeEventsBatch(prisma, [event(`artifact-${i}`)]);
  await decodeEventsBatch(prisma, [event("artifact-200")]);
  expect(queries.length).toBe(201);
  await decodeEventsBatch(prisma, [event("artifact-0")]);
  expect(queries.length).toBe(202);
});
