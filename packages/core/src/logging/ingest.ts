/**
 * on9log log ingestion: validate a raw packet, store it as a raw event,
 * and associate the decoding firmware artifact when known.
 *
 * Hot path only (broker process): strict packet parsing and a single
 * insert. No ELF access and no rendering happen here — decoding is done at
 * query time.
 */

import type { PrismaClient } from "../db";
import {
  On9logPacketType,
  parseOn9logPacket,
  type On9logPacket,
} from "../on9log/packet";

/** TTL for the in-process deviceUid -> deviceId cache. */
const DEVICE_CACHE_TTL_MS = 60_000;

/** Small in-process cache to cut the per-packet device lookup (M12). */
const deviceIdCache = new Map<string, { id: string; expiresAt: number }>();

async function resolveDeviceId(
  prisma: PrismaClient,
  deviceUid: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = deviceIdCache.get(deviceUid);
  if (cached && cached.expiresAt > now) return cached.id;
  const device = await prisma.device.findUnique({
    where: { deviceUid },
    select: { id: true },
  });
  if (!device) return null;
  deviceIdCache.set(deviceUid, { id: device.id, expiresAt: now + DEVICE_CACHE_TTL_MS });
  if (deviceIdCache.size > 10_000) deviceIdCache.clear(); // bounded
  return device.id;
}

export class LogIngestError extends Error {
  constructor(
    public readonly kind: "invalid_packet" | "database",
    message: string,
  ) {
    super(message);
    this.name = "LogIngestError";
  }
}

export interface IngestOutcome {
  stored: boolean;
  /** id of the stored raw event (always set when stored). */
  eventId: bigint | null;
  packetType: number;
}

/**
 * Validates an on9log packet and stores it in `raw_log_events`.
 *
 * @throws {LogIngestError} with kind `invalid_packet` when the payload is
 * not a well-formed on9log packet (the caller should drop it).
 */
export async function ingestLogPacket(
  prisma: PrismaClient,
  deviceId: string,
  packetBytes: Uint8Array,
): Promise<IngestOutcome> {
  let packet: On9logPacket;
  try {
    packet = parseOn9logPacket(packetBytes);
  } catch (error) {
    throw new LogIngestError(
      "invalid_packet",
      `invalid on9log packet: ${(error as Error).message}`,
    );
  }

  // resolve the decoding artifact from the device's latest reported firmware
  // (project-scoped: buildId is unique per project, not global)
  let artifactId: string | null = null;
  try {
    const state = await prisma.deviceFirmwareState.findUnique({
      where: { deviceId },
      select: { fwHash: true },
    });
    if (state) {
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { projectId: true },
      });
      if (device) {
        const artifact = await prisma.firmwareArtifact.findUnique({
          where: {
            projectId_buildId: { projectId: device.projectId, buildId: state.fwHash },
          },
          select: { id: true },
        });
        artifactId = artifact?.id ?? null;
      }
    }
  } catch (error) {
    // association failure must not drop the raw event
    artifactId = null;
  }

  try {
    const event = await prisma.rawLogEvent.create({
      data: {
        deviceId,
        artifactId,
        deviceTimeMs: BigInt(packet.header.timeMs),
        sequence: packet.header.seq,
        packetType: packet.header.type,
        level:
          packet.header.type === On9logPacketType.Log
            ? packet.header.level
            : null,
        tagId: packet.header.type === On9logPacketType.Log ? BigInt(packet.header.tagId) : null,
        fmtId: packet.header.type === On9logPacketType.Log ? BigInt(packet.header.fmtId) : null,
        rawPacket: Buffer.from(packetBytes),
        decodeState: artifactId ? "decodable" : "unknown_fw",
      },
    });
    return { stored: true, eventId: event.id, packetType: packet.header.type };
  } catch (error) {
    throw new LogIngestError(
      "database",
      `failed to store log event: ${(error as Error).message}`,
    );
  }
}
