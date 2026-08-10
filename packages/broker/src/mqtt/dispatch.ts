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
  confirmOtaTargetByFirmware,
  decodeDeviceCommandResult,
  decodeDeviceStat,
  decodeOtaResult,
  ingestLogPacket,
  LogContainerError,
  LogIngestError,
  parseDeviceTopic,
  parseLogContainer,
  PerDeviceLimiter,
  recordDeviceResult,
  recordOtaResult,
  resolveDeviceId,
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
    case "ota/result":
      await handleOtaResult(prisma, deviceUid, payload, log);
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
 * Records a device ota/result acknowledgement (proposal 18): the
 * acknowledgement drives the target state machine
 * (delivered/delivering -> downloaded/installed, -> failed with a code).
 * Terminal states are immutable; QoS1 duplicates update nothing.
 */
async function handleOtaResult(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  let result;
  try {
    result = decodeOtaResult(payload);
  } catch (error) {
    log.warn("ignored invalid ota result", {
      deviceUid,
      payloadBytes: payload.length,
      error: (error as Error).message,
    });
    return;
  }

  try {
    const updated = await recordOtaResult(prisma, {
      deviceUid,
      jobId: result.job_id,
      releaseId: result.release_id,
      state: result.state,
      code: result.code,
      message: result.message,
    });
    log.info("recorded ota result", {
      deviceUid,
      jobId: result.job_id,
      state: result.state,
      code: result.code,
      updated,
    });
  } catch (error) {
    log.warn("failed to record ota result", {
      deviceUid,
      jobId: result.job_id,
      error: (error as Error).message,
    });
  }
}

/**
 * Ingests on9log packets from the device `log` topic.
 *
 * The payload is a log container: first byte 0x9a = a single raw on9log
 * packet (the original wire format), 0x01 = a MsgPack array of on9log
 * packets (one MQTT publish carries a bundle; a device bursts its logs
 * into a bundle to amortise the per-packet MQTT/WS/TCP overhead).
 * Unknown first bytes are rejected. Elements are validated strictly and
 * stored individually in `raw_log_events` (one row per packet, so
 * decoding and the realtime WS stream are unchanged); decoding happens
 * at query time, never here.
 */
async function handleLog(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  try {
    const deviceId = await resolveDeviceId(prisma, deviceUid);
    if (!deviceId) {
      log.warn("ignored log from unknown device", { deviceUid });
      return;
    }
    const parsed = parseLogContainer(payload);
    let stored = 0;
    let dropped = parsed.dropped;
    if (dropped > 0) {
      log.warn("ignored invalid log element(s)", {
        deviceUid,
        dropped,
        reason: "invalid_packet",
      });
    }
    for (const element of parsed.elements) {
      try {
        await ingestLogPacket(prisma, deviceId, element);
        stored++;
      } catch (error) {
        const kind = (error as LogIngestError).kind as string | undefined;
        if (kind === "invalid_packet") {
          // one bad element must not kill the rest of the bundle
          dropped++;
          continue;
        }
        // database failure: the remaining elements would fail identically
        log.warn("failed to store device log packet", {
          deviceUid,
          reason: kind ?? "database",
          error: (error as Error).message,
        });
        break;
      }
    }
    log.debug("ingested device log bundle", { deviceUid, stored, dropped });
  } catch (error) {
    const kind =
      (error as LogContainerError).kind ?? (error as LogIngestError).kind;
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
    const deviceId = await resolveDeviceId(prisma, deviceUid);
    if (!deviceId) {
      log.warn("ignored stat from unknown device", { deviceUid });
      return;
    }
    const previous = await prisma.deviceFirmwareState.findUnique({
      where: { deviceId },
      select: { fwHash: true },
    });
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId },
      update: { fwHash, reportedAt: new Date() },
      create: { deviceId, fwHash },
    });
    log.debug("recorded device firmware state", {
      deviceUid,
      fwHash,
    });
    // OTA fact layer (proposal 18): a firmware CHANGE that matches a
    // release's ELF build id confirms the device actually runs the new
    // firmware — the only driver of the completed terminal state.
    if (previous?.fwHash !== fwHash) {
      const confirmed = await confirmOtaTargetByFirmware(prisma, deviceId, fwHash);
      if (confirmed > 0) {
        log.info("ota target confirmed by firmware state", {
          deviceUid,
          fwHash,
          confirmed,
        });
      }
    }
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
