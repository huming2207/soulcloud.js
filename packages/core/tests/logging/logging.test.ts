import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  computeBuildId,
  importArtifact,
  ingestLogPacket,
  backfillDecodeState,
  decodeRawEvent,
  prisma,
  SlipDecoder,
  parseOn9logPacket,
  ON9LOG_FRAME_TYPE_ON9LOG,
} from "@soulcloud/core";

// Integration fixtures: the compiled on9log Unix demo ELF and its SLIP output.
const DEMO_ELF_PATH = "/tmp/on9log_unix_demo";
const DEMO_OUTPUT_PATH = "/tmp/on9log_demo_output.bin";

const hasFixtures = (() => {
  try {
    readFileSync(DEMO_ELF_PATH);
    readFileSync(DEMO_OUTPUT_PATH);
    return true;
  } catch {
    return false;
  }
})();

function demoLogPackets(): Uint8Array[] {
  const decoder = new SlipDecoder();
  decoder.push(readFileSync(DEMO_OUTPUT_PATH));
  return decoder
    .frames()
    .filter((f) => f.type === ON9LOG_FRAME_TYPE_ON9LOG)
    .map((f) => f.payload);
}

let projectId: string;
let deviceId: string;
let artifactId: string;
let buildId: string;

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "log-ingest-test" },
  });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: `ingest-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-ingest",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
  if (artifactId) {
    await prisma.firmwareLogString.deleteMany({ where: { artifactId } });
    await prisma.firmwareArtifact.deleteMany({ where: { id: artifactId } });
  }
  await prisma.device.deleteMany({ where: { id: deviceId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("artifact import (real demo ELF)", () => {
  test("imports the ELF and extracts the dictionary", () => {
    if (!hasFixtures) return;
    const elf = readFileSync(DEMO_ELF_PATH);
    buildId = computeBuildId(elf);

    return importArtifact(prisma, { projectId, elf }).then(async (result) => {
      artifactId = result.artifactId;
      expect(result.buildId).toBe(buildId);
      expect(result.tagCount).toBeGreaterThan(0);
      expect(result.formatCount).toBeGreaterThan(0);

      const tags = await prisma.firmwareLogString.findMany({
        where: { artifactId, kind: "tag" },
      });
      const formats = await prisma.firmwareLogString.findMany({
        where: { artifactId, kind: "format" },
      });
      expect(tags.length).toBe(result.tagCount);
      expect(formats.length).toBe(result.formatCount);
      expect(tags.some((t) => t.value === "demo")).toBe(true);
      expect(formats.some((f) => f.value.includes("%"))).toBe(true);
    });
  });

  test("importing the same build is idempotent", async () => {
    if (!hasFixtures) return;
    const elf = readFileSync(DEMO_ELF_PATH);
    const again = await importArtifact(prisma, { projectId, elf });
    expect(again.artifactId).toBe(artifactId);
    const count = await prisma.firmwareArtifact.count({ where: { buildId } });
    expect(count).toBe(1);
  });

  test("rejects a non-ELF file", async () => {
    await expect(
      importArtifact(prisma, {
        projectId,
        elf: new TextEncoder().encode("definitely not an elf"),
      }),
    ).rejects.toMatchObject({ kind: "invalid_elf" });
  });
});

describe("log ingestion", () => {
  test("stores raw packets and associates the artifact via fw state", async () => {
    if (!hasFixtures) return;
    // device reports firmware first (as stat would)
    await prisma.deviceFirmwareState.create({
      data: { deviceId, fwHash: buildId },
    });

    const packets = demoLogPackets();
    expect(packets.length).toBeGreaterThan(5);

    for (const packet of packets) {
      const outcome = await ingestLogPacket(prisma, deviceId, packet);
      expect(outcome.stored).toBe(true);
    }

    const events = await prisma.rawLogEvent.findMany({
      where: { deviceId },
      orderBy: { id: "asc" },
    });
    expect(events.length).toBe(packets.length);
    expect(events.every((e) => e.artifactId === artifactId)).toBe(true);
    expect(events.every((e) => e.decodeState === "decodable")).toBe(true);
    expect(events.every((e) => e.rawPacket.length > 0)).toBe(true);

    // envelope fields are populated for LOG packets
    const logEvents = events.filter((e) => e.packetType === 0);
    expect(logEvents.length).toBeGreaterThan(0);
    expect(logEvents[0]!.level).not.toBeNull();
    expect(logEvents[0]!.tagId).not.toBeNull();
    expect(logEvents[0]!.fmtId).not.toBeNull();
  });

  test("rejects invalid packets without storing", async () => {
    await expect(
      ingestLogPacket(prisma, deviceId, new Uint8Array([0x00, 0x01, 0x02])),
    ).rejects.toMatchObject({ kind: "invalid_packet" });
    const count = await prisma.rawLogEvent.count({
      where: { deviceId },
    });
    expect(count).toBeGreaterThan(0); // unchanged by the failed ingest
  });
});

describe("decoding", () => {
  test("decodes stored events end-to-end", async () => {
    if (!hasFixtures) return;
    const events = await prisma.rawLogEvent.findMany({
      where: { deviceId, decodeState: "decodable", packetType: 0 },
      orderBy: { id: "asc" },
      take: 10,
    });
    expect(events.length).toBeGreaterThan(0);

    let decodedCount = 0;
    for (const event of events) {
      const decoded = await decodeRawEvent(prisma, event);
      if (decoded.message !== null) {
        decodedCount++;
        expect(decoded.tag).toBe("demo");
        expect(decoded.message.length).toBeGreaterThan(0);
      }
    }
    expect(decodedCount).toBeGreaterThan(0);
  });

  test("returns null message for unknown-fw events", async () => {
    if (!hasFixtures) return;
    const event = await prisma.rawLogEvent.findFirstOrThrow({
      where: { deviceId },
      orderBy: { id: "asc" },
    });
    const decoded = await decodeRawEvent(prisma, {
      ...event,
      artifactId: null,
      decodeState: "unknown_fw",
    });
    expect(decoded.message).toBeNull();
    expect(decoded.tag).toBeNull();
  });

  test("backfill makes previously unknown events decodable", async () => {
    // simulate events stored before the artifact existed
    const orphan = await ingestWithoutArtifact();
    expect(orphan.decodeState).toBe("unknown_fw");
    expect(orphan.artifactId).toBeNull();

    const backfilled = await backfillDecodeState(prisma, artifactId, buildId);
    expect(backfilled).toBeGreaterThanOrEqual(1);

    const updated = await prisma.rawLogEvent.findUniqueOrThrow({
      where: { id: orphan.id },
    });
    expect(updated.decodeState).toBe("decodable");
    expect(updated.artifactId).toBe(artifactId);

    const decoded = await decodeRawEvent(prisma, updated);
    expect(decoded.message).not.toBeNull();
  });
});

/** Stores a log packet with no firmware state (orphan, unknown_fw). */
async function ingestWithoutArtifact() {
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
  try {
    const packet = demoLogPackets()[0]!;
    const outcome = await ingestLogPacket(prisma, deviceId, packet);
    const event = await prisma.rawLogEvent.findFirstOrThrow({
      where: { id: outcome.eventId! },
    });
    return event;
  } finally {
    await prisma.deviceFirmwareState.create({
      data: { deviceId, fwHash: buildId },
    });
  }
}
