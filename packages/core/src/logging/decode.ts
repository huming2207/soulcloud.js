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

/** A raw event as required for decoding. */
export interface RawEventForDecode {
  id: bigint;
  artifactId: string | null;
  packetType: number;
  tagId: bigint | null;
  fmtId: bigint | null;
  rawPacket: Uint8Array;
}

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
  event: RawEventForDecode,
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
          address: BigInt(event.tagId),
          kind: "tag",
        },
      },
      select: { value: true },
    }),
    prisma.firmwareLogString.findUnique({
      where: {
        artifactId_address_kind: {
          artifactId: event.artifactId,
          address: BigInt(event.fmtId),
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


/**
 * Decodes a page of events with bounded dictionary queries (avoids the
 * N+1 query storm of per-event lookups): dictionaries are loaded once per
 * artifact, then events are matched in memory.
 */
export async function decodeEventsBatch(
  prisma: PrismaClient,
  events: RawEventForDecode[],
): Promise<DecodedEvent[]> {
  const out: DecodedEvent[] = [];
  const artifactIds = new Set(
    events.filter((e) => e.artifactId !== null).map((e) => e.artifactId!),
  );
  const dictionaries = new Map<string, Map<string, string>>();
  for (const artifactId of artifactIds) {
    const rows = await prisma.firmwareLogString.findMany({
      where: { artifactId },
      select: { kind: true, address: true, value: true },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(`${row.kind}:${row.address.toString()}`, row.value);
    }
    dictionaries.set(artifactId, map);
  }

  for (const event of events) {
    if (
      event.packetType !== On9logPacketType.Log ||
      event.artifactId === null ||
      event.tagId === null ||
      event.fmtId === null
    ) {
      out.push({ tag: null, message: null });
      continue;
    }
    const dict = dictionaries.get(event.artifactId);
    const tag = dict?.get(`tag:${event.tagId.toString()}`);
    const fmt = dict?.get(`format:${event.fmtId.toString()}`);
    if (!dict || tag === undefined || fmt === undefined) {
      out.push({ tag: null, message: null });
      continue;
    }
    try {
      const packet = parseOn9logPacket(event.rawPacket);
      if (packet.kind !== "log") {
        out.push({ tag: null, message: null });
        continue;
      }
      out.push({ tag, message: renderFormat(fmt, packet.args) });
    } catch {
      out.push({ tag: null, message: null });
    }
  }
  return out;
}
