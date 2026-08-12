/**
 * on9log log ingestion: validate a raw packet, store it as a raw event,
 * and associate the decoding firmware artifact when known.
 *
 * Hot path only (broker process): strict packet parsing and a single
 * insert. No ELF access and no rendering happen here — decoding is done at
 * query time.
 */

import type { PrismaClient } from "../db";
import { LOG_EVENTS_CHANNEL } from "../queue/notify";
import {
  On9logPacketType,
  parseOn9logPacket,
  type On9logPacket,
} from "../on9log/packet";

/** TTL for the in-process deviceUid -> deviceId cache. */
const DEVICE_CACHE_TTL_MS = 60_000;

/** Small in-process cache to cut the per-packet device lookup (M12). */
const deviceIdCache = new Map<string, { id: string; expiresAt: number }>();

export async function resolveDeviceId(
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

export interface LogBundleOutcome {
  /** Rows inserted. */
  stored: number;
  /** Elements skipped because they were not well-formed on9log packets. */
  dropped: number;
}

/**
 * Resolves the decoding artifact for a device's latest reported firmware
 * (project-scoped: buildId is unique per project, not global).
 *
 * Never throws: an association failure must not drop raw events — the
 * raw packet stays queryable and `decodeState` just stays "unknown_fw"
 * (it can be backfilled once the firmware is imported).
 */
async function resolveArtifactId(
  prisma: PrismaClient,
  deviceId: string,
): Promise<string | null> {
  try {
    // One indexed join instead of serial firmware-state -> device -> artifact
    // lookups. This runs for every log bundle and the artifact may be absent;
    // LEFT JOIN preserves the existing unknown_fw behavior in that case.
    const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT artifact.id
      FROM device_firmware_state AS state
      INNER JOIN devices AS device ON device.id = state.device_id
      LEFT JOIN firmware_artifacts AS artifact
        ON artifact.project_id = device.project_id
       AND artifact."buildId" = state.fw_hash
      WHERE state.device_id = ${deviceId}::uuid
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
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

  const artifactId = await resolveArtifactId(prisma, deviceId);

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
    // wake the web console's realtime log stream (lossy: a missed
    // notification only costs latency - consumers fall back to REST).
    // Payload = the device id only: the WS hub tracks its own per-device
    // high-water mark and queries everything above it, so it does not
    // need (and must not trust) event ids in the notification.
    try {
      await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${deviceId})`;
    } catch {
      // notification failure must not drop the stored event
    }
    return { stored: true, eventId: event.id, packetType: packet.header.type };
  } catch (error) {
    throw new LogIngestError(
      "database",
      `failed to store log event: ${(error as Error).message}`,
    );
  }
}

/**
 * Validates and stores a whole log bundle in one pass.
 *
 * Bulk path for the container protocol: each element is validated strictly
 * (a bad element drops only itself), the decoding artifact is resolved
 * once, all valid elements are inserted in a single `createMany`, and one
 * pg_notify wakes the realtime stream. This replaces N serial
 * ingestLogPacket calls (each of which did its own fw-state/project/
 * artifact lookups, insert and notify) — the WEB-03 amplification fix.
 *
 * @throws {LogIngestError} with kind `database` when the insert fails (the
 * whole bundle is then rejected; per-element on9log errors are counted in
 * `dropped` instead).
 */
export async function ingestLogBundle(
  prisma: PrismaClient,
  deviceId: string,
  elements: Uint8Array[],
): Promise<LogBundleOutcome> {
  const rows: Array<{
    deviceTimeMs: bigint;
    sequence: number;
    packetType: number;
    level: number | null;
    tagId: bigint | null;
    fmtId: bigint | null;
    rawPacket: Buffer<ArrayBuffer>;
  }> = [];
  let dropped = 0;
  for (const element of elements) {
    let packet: On9logPacket;
    try {
      packet = parseOn9logPacket(element);
    } catch {
      dropped++; // one bad element must not kill the rest of the bundle
      continue;
    }
    const isLog = packet.header.type === On9logPacketType.Log;
    rows.push({
      deviceTimeMs: BigInt(packet.header.timeMs),
      sequence: packet.header.seq,
      packetType: packet.header.type,
      level: isLog ? packet.header.level : null,
      tagId: isLog ? BigInt(packet.header.tagId) : null,
      fmtId: isLog ? BigInt(packet.header.fmtId) : null,
      rawPacket: Buffer.from(element),
    });
  }
  if (rows.length === 0) return { stored: 0, dropped };

  const artifactId = await resolveArtifactId(prisma, deviceId);
  try {
    await prisma.rawLogEvent.createMany({
      data: rows.map((row) => ({
        deviceId,
        artifactId,
        decodeState: artifactId ? "decodable" : "unknown_fw",
        ...row,
      })),
    });
    // one notification for the whole bundle; the hub re-queries from its
    // own high-water mark, so a single payload is enough
    try {
      await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${deviceId})`;
    } catch {
      // notification failure must not drop the stored events
    }
    return { stored: rows.length, dropped };
  } catch (error) {
    throw new LogIngestError(
      "database",
      `failed to store log bundle: ${(error as Error).message}`,
    );
  }
}
