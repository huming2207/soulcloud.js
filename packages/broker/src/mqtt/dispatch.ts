/**
 * Routes device-to-platform MQTT messages (mirrors the Rust worker's message
 * handling): validate strictly, then act per message kind.
 *
 *   - cmd/result: validate with the shared codec, then record the terminal
 *     result in the durable command queue
 *   - stat: validate; persistence semantics are not yet defined, so only
 *     log metadata (same as the Rust version)
 *   - log: payload contract not yet defined; log metadata only
 *
 * Unexpected topics and invalid payloads are logged without the raw payload
 * (avoid leaking device data and log amplification).
 */

import type { Aedes } from "aedes";
import {
  CommandQueueError,
  type CommandQueueErrorKind,
  decodeDeviceCommandResult,
  decodeDeviceStat,
  ingestLogPacket,
  LogIngestError,
  parseDeviceTopic,
  PerDeviceLimiter,
  recordDeviceResult,
  type PrismaClient,
} from "@soulcloud/core";

/** Uplink ingestion protection options (DDoS / misbehaving devices). */
export interface DispatchGuardOptions {
  /** Maximum accepted uplink packet size in bytes. */
  maxPacketBytes: number;
  /** Per-device sustained rate (packets per second). */
  ratePerSecond: number;
  /** Per-device burst allowance. */
  rateBurst: number;
}

export interface DispatchLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Attaches the uplink message handler to an Aedes broker.
 *
 * `guards` enables per-device packet-size and rate limits. When a device
 * exceeds them its messages are dropped (logged) — never buffered — so a
 * faulty or hostile device cannot fill memory or storage.
 */
export function attachDispatch(
  aedes: Aedes,
  prisma: PrismaClient,
  log: DispatchLog,
  guards?: DispatchGuardOptions,
): void {
  const limiter = guards
    ? new PerDeviceLimiter({
        capacity: guards.rateBurst,
        refillPerSecond: guards.ratePerSecond,
      })
    : null;

  aedes.on("publish", (packet, client) => {
    if (!client) return; // server-side or internal publishes
    const payload =
      typeof packet.payload === "string"
        ? Buffer.from(packet.payload)
        : packet.payload;

    if (guards && payload.length > guards.maxPacketBytes) {
      log.warn("dropped oversized uplink packet", {
        deviceUid: client.id,
        payloadBytes: payload.length,
        maxBytes: guards.maxPacketBytes,
      });
      return;
    }
    if (limiter && !limiter.tryConsume(client.id)) {
      log.warn("dropped uplink packet over rate limit", {
        deviceUid: client.id,
      });
      return;
    }

    void handleUplink(prisma, client.id, packet.topic, payload, log);
  });
}

async function handleUplink(
  prisma: PrismaClient,
  deviceUid: string,
  topicName: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  let topic;
  try {
    topic = parseDeviceTopic(topicName);
  } catch {
    log.warn("ignored unexpected topic", { topic: topicName });
    return;
  }
  if (topic.deviceUid !== deviceUid) {
    log.warn("ignored topic for another device", { topic: topicName });
    return;
  }

  switch (topic.kind) {
    case "cmd/result":
      await handleCommandResult(prisma, deviceUid, payload, log);
      break;
    case "stat":
      await handleStat(prisma, deviceUid, payload, log);
      break;
    case "log":
      await handleLog(prisma, deviceUid, payload, log);
      break;
  }
}

async function handleCommandResult(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  let result;
  try {
    result = decodeDeviceCommandResult(payload);
  } catch (error) {
    log.warn("ignored invalid device command result", {
      deviceUid,
      payloadBytes: payload.length,
      error: (error as Error).message,
    });
    return;
  }

  try {
    const outcome = await recordDeviceResult(prisma, deviceUid, result, payload);
    log.info("recorded device command result", {
      deviceUid,
      commandId: bytesToUuid(result.id),
      sequence: result.seq.toString(),
      code: result.code,
      outcome,
    });
  } catch (error) {
    const kind = (error as CommandQueueError).kind as CommandQueueErrorKind | undefined;
    if (kind === "result_mismatch" || kind === "conflicting_result") {
      log.warn("ignored unmatched device command result", {
        deviceUid,
        error: (error as Error).message,
      });
    } else {
      log.warn("failed to record device command result", {
        deviceUid,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Ingests a raw on9log packet from the device `log` topic.
 *
 * The packet is validated strictly and stored in `raw_log_events` with its
 * envelope metadata; decoding happens at query time, never here.
 */
async function handleLog(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  try {
    const device = await prisma.device.findUnique({
      where: { deviceUid },
      select: { id: true },
    });
    if (!device) {
      log.warn("ignored log from unknown device", { deviceUid });
      return;
    }
    const outcome = await ingestLogPacket(prisma, device.id, payload);
    log.debug("stored device log packet", {
      deviceUid,
      eventId: outcome.eventId?.toString(),
      packetType: outcome.packetType,
    });
  } catch (error) {
    const kind = (error as LogIngestError).kind as string | undefined;
    log.warn("ignored device log packet", {
      deviceUid,
      payloadBytes: payload.length,
      reason: kind ?? "database",
      error: (error as Error).message,
    });
  }
}

/**
 * Validates a device status report and persists the latest firmware state
 * (stat.fw -> device_firmware_state), which associates log packets with
 * their decoding artifact.
 */
async function handleStat(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  let stat;
  try {
    stat = decodeDeviceStat(payload);
  } catch (error) {
    log.warn("ignored invalid device status", {
      deviceUid,
      payloadBytes: payload.length,
      error: (error as Error).message,
    });
    return;
  }

  const fwHash = Buffer.from(stat.fw).toString("hex");
  try {
    const device = await prisma.device.findUnique({
      where: { deviceUid },
      select: { id: true },
    });
    if (!device) {
      log.warn("ignored stat from unknown device", { deviceUid });
      return;
    }
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId: device.id },
      update: { fwHash, reportedAt: new Date() },
      create: { deviceId: device.id, fwHash },
    });
    log.debug("recorded device firmware state", {
      deviceUid,
      fwHash,
    });
  } catch (error) {
    log.warn("failed to record device firmware state", {
      deviceUid,
      error: (error as Error).message,
    });
  }
}

/** Formats 16 raw ID bytes as a dashed UUID for logging. */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
