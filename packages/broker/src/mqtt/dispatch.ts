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
  parseDeviceTopic,
  recordDeviceResult,
  type PrismaClient,
} from "@soulcloud/core";

export interface DispatchLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Attaches the uplink message handler to an Aedes broker.
 */
export function attachDispatch(
  aedes: Aedes,
  prisma: PrismaClient,
  log: DispatchLog,
): void {
  aedes.on("publish", (packet, client) => {
    if (!client) return; // server-side or internal publishes
    const payload =
      typeof packet.payload === "string"
        ? Buffer.from(packet.payload)
        : packet.payload;
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
      handleStat(deviceUid, payload, log);
      break;
    case "log":
      log.debug("received device log message", {
        deviceUid,
        payloadBytes: payload.length,
      });
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

function handleStat(
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): void {
  try {
    const stat = decodeDeviceStat(payload);
    log.debug("received device status", {
      deviceUid,
      uptime: stat.up.toString(),
      payloadBytes: payload.length,
    });
    // Persistence belongs here once status storage semantics are agreed.
  } catch (error) {
    log.warn("ignored invalid device status", {
      deviceUid,
      payloadBytes: payload.length,
      error: (error as Error).message,
    });
  }
}

/** Formats 16 raw ID bytes as a dashed UUID for logging. */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
