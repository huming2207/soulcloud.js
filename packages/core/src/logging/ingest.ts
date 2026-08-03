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
  /** null when the packet is valid but not stored (e.g. non-LOG control packets). */
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
  let artifactId: string | null = null;
  try {
    const state = await prisma.deviceFirmwareState.findUnique({
      where: { deviceId },
      select: { fwHash: true },
    });
    if (state) {
      const artifact = await prisma.firmwareArtifact.findUnique({
        where: { buildId: state.fwHash },
        select: { id: true },
      });
      artifactId = artifact?.id ?? null;
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
        deviceTimeMs: packet.header.timeMs,
        sequence: packet.header.seq,
        packetType: packet.header.type,
        level:
          packet.header.type === On9logPacketType.Log
            ? packet.header.level
            : null,
        tagId: packet.header.type === On9logPacketType.Log ? packet.header.tagId : null,
        fmtId: packet.header.type === On9logPacketType.Log ? packet.header.fmtId : null,
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
