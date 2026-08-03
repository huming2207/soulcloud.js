/**
 * On-demand log decoding at query time: resolve tag/format IDs through the
 * artifact dictionary and render the message text.
 *
 * The raw event always remains the source of truth; decoding is a read-only
 * projection. Events without a known artifact return null message.
 */

import type { PrismaClient } from "../db";
import {
  On9logArgType,
  On9logPacketType,
  parseOn9logPacket,
} from "../on9log/packet";
import { renderFormat } from "../on9log/render";

export interface DecodedEvent {
  /** null when the packet cannot be decoded (unknown firmware / malformed). */
  message: string | null;
  tag: string | null;
}

/**
 * Decodes one stored raw log event.
 *
 * @returns tag and rendered message, or nulls when decoding is not possible.
 * Never throws for undecodable events (the caller returns null message);
 * throws only on unexpected database errors.
 */
export async function decodeRawEvent(
  prisma: PrismaClient,
  event: {
    id: bigint;
    artifactId: string | null;
    packetType: number;
    tagId: number | null;
    fmtId: number | null;
    rawPacket: Uint8Array;
  },
): Promise<DecodedEvent> {
  if (event.packetType !== On9logPacketType.Log) {
    // DROPPED / TIME_SYNC / BUFFER have no tag/format rendering here
    return { message: null, tag: null };
  }
  if (event.artifactId === null || event.tagId === null || event.fmtId === null) {
    return { message: null, tag: null };
  }

  // fetch the dictionary entries for this artifact
  const [tagRow, fmtRow] = await Promise.all([
    prisma.firmwareLogString.findUnique({
      where: {
        artifactId_address_kind: {
          artifactId: event.artifactId,
          address: event.tagId,
          kind: "tag",
        },
      },
      select: { value: true },
    }),
    prisma.firmwareLogString.findUnique({
      where: {
        artifactId_address_kind: {
          artifactId: event.artifactId,
          address: event.fmtId,
          kind: "format",
        },
      },
      select: { value: true },
    }),
  ]);

  if (!tagRow || !fmtRow) {
    // dictionary gap: raw data remains, decode later after re-import
    return { message: null, tag: null };
  }

  // parse the stored raw packet to recover the arguments
  let packet;
  try {
    packet = parseOn9logPacket(event.rawPacket);
  } catch {
    return { message: null, tag: null };
  }
  if (packet.kind !== "log") {
    return { message: null, tag: null };
  }

  try {
    return {
      tag: tagRow.value,
      message: renderFormat(fmtRow.value, packet.args),
    };
  } catch {
    // format/args mismatch: report as undecodable rather than failing
    // the whole query
    return { message: null, tag: tagRow.value };
  }
}

export interface DecodedArgsSummary {
  argCount: number;
  hasStrings: boolean;
}

/** Cheap summary of a packet's args (for diagnostics; no rendering). */
export function summarizeArgs(packetBytes: Uint8Array): DecodedArgsSummary | null {
  try {
    const packet = parseOn9logPacket(packetBytes);
    if (packet.kind !== "log") return null;
    return {
      argCount: packet.args.length,
      hasStrings: packet.args.some(
        (a) =>
          a.type === On9logArgType.DynamicString ||
          a.type === On9logArgType.DynamicStringView,
      ),
    };
  } catch {
    return null;
  }
}
