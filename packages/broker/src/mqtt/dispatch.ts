/**
 * Routes device-to-platform MQTT messages (mirrors the Rust worker's message
 * handling): validate strictly, then act per message kind.
 *
 *   - cmd/result: validate with the shared codec, then record the terminal
 *     result in the durable command queue
 *   - stat: validate; persistence semantics are not yet defined, so only
 *     log metadata (same as the Rust version)
 *   - log: payload contract not yet defined; log metadata only
 *   - event: validate the generic envelope and persist an opaque, immutable
 *     plugin event row; plugin-specific data is never decoded by the broker
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
  decodeDeviceEvent,
  ingestDeviceEvent,
  ingestLogBundle,
  LogContainerError,
  LogIngestError,
  parseDeviceTopic,
  parseLogContainer,
  PerDeviceLimiter,
  recordDeviceResult,
  recordOtaResult,
  resolveDeviceId,
  type LogContainer,
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
  /** Maximum uplink handlers executing concurrently across all devices. */
  workConcurrency?: number;
  /** Maximum executing + queued uplinks retained by this broker process. */
  workCapacity?: number;
  /**
   * Maximum TOTAL payload bytes retained by executing + queued uplinks.
   * A count-only cap would still allow capacity x maxPacketBytes (e.g.
   * 1024 x 256KB = 256MB) of buffers per process. Defaults to 32 MiB.
   */
  workMaxBytes?: number;
}

const DEFAULT_WORK_CONCURRENCY = 16;
const DEFAULT_WORK_CAPACITY = 1024;
const DEFAULT_WORK_MAX_BYTES = 32 * 1024 * 1024;

export interface UplinkWork {
  deviceUid: string;
  /** Payload size in bytes (for the byte budget below). */
  byteSize: number;
  run: () => Promise<void>;
}

/**
 * Bounded, per-device-ordered uplink executor. Different devices may run in
 * parallel up to `concurrency`; one device never has two handlers in flight.
 *
 * Admission is bounded by BOTH work count (`capacity`) and total buffered
 * bytes (`maxBytes`): a count-only cap would still let the queue retain
 * capacity x max-packet-size (e.g. 1024 x 256KB = 256MB) of payload
 * buffers per broker process.
 */
export class UplinkWorkQueue {
  private readonly byDevice = new Map<string, UplinkWork[]>();
  private readonly activeDevices = new Set<string>();
  private readonly readyDevices: string[] = [];
  private running = 0;
  private outstanding = 0;
  private outstandingBytes = 0;

  constructor(
    private readonly concurrency: number,
    private readonly capacity: number,
    private readonly maxBytes: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new RangeError("uplink work concurrency must be a positive integer");
    }
    if (!Number.isInteger(capacity) || capacity < concurrency) {
      throw new RangeError("uplink work capacity must be an integer >= concurrency");
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("uplink work maxBytes must be a positive integer");
    }
  }

  /** Returns false when accepting the work would exceed a hard limit. */
  enqueue(work: UplinkWork): boolean {
    if (this.outstanding >= this.capacity) return false;
    if (this.outstandingBytes + work.byteSize > this.maxBytes) return false;
    let queue = this.byDevice.get(work.deviceUid);
    if (!queue) {
      queue = [];
      this.byDevice.set(work.deviceUid, queue);
    }
    const wasEmpty = queue.length === 0;
    queue.push(work);
    this.outstanding += 1;
    this.outstandingBytes += work.byteSize;
    if (wasEmpty && !this.activeDevices.has(work.deviceUid)) {
      this.readyDevices.push(work.deviceUid);
    }
    this.drain();
    return true;
  }

  private drain(): void {
    while (this.running < this.concurrency && this.readyDevices.length > 0) {
      const deviceUid = this.readyDevices.shift()!;
      if (this.activeDevices.has(deviceUid)) continue;
      const queue = this.byDevice.get(deviceUid);
      const work = queue?.shift();
      if (!queue || !work) continue;
      this.activeDevices.add(deviceUid);
      this.running += 1;
      void work.run().finally(() => {
        this.running -= 1;
        this.outstanding -= 1;
        this.outstandingBytes -= work.byteSize;
        this.activeDevices.delete(deviceUid);
        if (queue.length > 0) {
          this.readyDevices.push(deviceUid);
        } else {
          this.byDevice.delete(deviceUid);
        }
        this.drain();
      });
    }
  }
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
  const workQueue = new UplinkWorkQueue(
    guards?.workConcurrency ?? DEFAULT_WORK_CONCURRENCY,
    guards?.workCapacity ?? DEFAULT_WORK_CAPACITY,
    guards?.workMaxBytes ?? DEFAULT_WORK_MAX_BYTES,
  );
  const preHandledEvents = new WeakSet<object>();
  const authorizePublish = aedes.authorizePublish.bind(aedes);

  // Aedes writes a QoS 1 PUBACK before emitting its `publish` event. Gate the
  // generic /event path here so a valid event is durable before ACK. Invalid
  // device data is deliberately acknowledged and dropped; a database failure
  // is returned to Aedes so the device retransmits instead of losing data.
  aedes.authorizePublish = (client, packet, callback) => {
    authorizePublish(client, packet, (authorizationError) => {
      if (authorizationError || !client || !isOwnEventTopic(client.id, packet.topic)) {
        callback(authorizationError);
        return;
      }
      const payload = typeof packet.payload === "string"
        ? Buffer.from(packet.payload)
        : (packet.payload ?? Buffer.alloc(0));
      if (guards && payload.length > guards.maxPacketBytes) {
        log.warn("dropped oversized uplink packet", { deviceUid: client.id, payloadBytes: payload.length, maxBytes: guards.maxPacketBytes });
        preHandledEvents.add(packet);
        callback(null);
        return;
      }
      if (limiter && !limiter.tryConsume(client.id, 1)) {
        log.warn("dropped uplink packet over rate limit", { deviceUid: client.id });
        preHandledEvents.add(packet);
        callback(null);
        return;
      }
      const accepted = workQueue.enqueue({
        deviceUid: client.id,
        byteSize: payload.length,
        run: async () => {
          try {
            await persistDeviceEvent(prisma, client.id, payload, log);
            preHandledEvents.add(packet);
            callback(null);
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      if (!accepted) callback(new Error("broker uplink work limit reached"));
    });
  };

  aedes.on("publish", (packet, client) => {
    if (!client) return; // server-side or internal publishes
    if (preHandledEvents.delete(packet)) return;
    // defensive: mqtt-packet always produces a payload for PUBLISH, but a
    // missing one must never crash the broker via the sync event listener
    const payload =
      typeof packet.payload === "string"
        ? Buffer.from(packet.payload)
        : (packet.payload ?? Buffer.alloc(0));

    if (guards && payload.length > guards.maxPacketBytes) {
      log.warn("dropped oversized uplink packet", {
        deviceUid: client.id,
        payloadBytes: payload.length,
        maxBytes: guards.maxPacketBytes,
      });
      return;
    }
    // A rate-limited log bundle needs structural parsing to charge one token
    // per contained packet. Pass that result down to ingestion so a valid
    // bundle is parsed only once on this hot path.
    const parsedLog = limiter ? parseRateLimitedLog(packet.topic, payload) : undefined;
    const cost = parsedLog instanceof LogContainerError
      ? 1
      : Math.max(1, parsedLog?.elements.length ?? 1);
    if (limiter && !limiter.tryConsume(client.id, cost)) {
      log.warn("dropped uplink packet over rate limit", {
        deviceUid: client.id,
      });
      return;
    }

    const accepted = workQueue.enqueue({
      deviceUid: client.id,
      byteSize: payload.length,
      run: async () => {
        try {
          await handleUplink(prisma, client.id, packet.topic, payload, log, parsedLog);
        } catch (error) {
          log.warn("uplink handler failed", {
            deviceUid: client.id,
            error: (error as Error).message,
          });
        }
      },
    });
    if (!accepted) {
      log.warn("dropped uplink packet over global work limit", {
        deviceUid: client.id,
      });
    }
  });
}

/**
 * Parses a rate-limited log container once. A malformed container is kept as
 * its original error so handleLog can report the same validation failure
 * without a second pass. Other uplinks cost one token and need no parsing.
 */
function parseRateLimitedLog(
  topic: string,
  payload: Uint8Array,
): LogContainer | LogContainerError | undefined {
  if (!topic.endsWith("/log")) return undefined;
  try {
    return parseLogContainer(payload);
  } catch (error) {
    return error instanceof LogContainerError
      ? error
      : new LogContainerError("invalid_msgpack", "failed to parse log container");
  }
}

async function handleUplink(
  prisma: PrismaClient,
  deviceUid: string,
  topicName: string,
  payload: Uint8Array,
  log: DispatchLog,
  parsedLog?: LogContainer | LogContainerError,
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
      await handleLog(prisma, deviceUid, payload, log, parsedLog);
      break;
    case "event":
      await handleEvent(prisma, deviceUid, payload, log);
      break;
  }
}

async function handleEvent(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  try {
    await persistDeviceEvent(prisma, deviceUid, payload, log);
  } catch {
    // This fallback path runs after ACK (for direct/event-emitter callers).
    // The real MQTT path is gated in authorizePublish and propagates failure.
  }
}

async function persistDeviceEvent(
  prisma: PrismaClient,
  deviceUid: string,
  payload: Uint8Array,
  log: DispatchLog,
): Promise<void> {
  let event;
  try {
    event = decodeDeviceEvent(payload);
  } catch (error) {
    log.warn("ignored invalid device event", {
      deviceUid,
      payloadBytes: payload.length,
      error: (error as Error).message,
    });
    return;
  }

  try {
    const outcome = await ingestDeviceEvent(prisma, deviceUid, event, payload);
    if (outcome.status === "unknown_device") {
      log.warn("ignored event from unknown device", { deviceUid });
      return;
    }
    if (outcome.status === "conflict") {
      log.warn("ignored conflicting reuse of device event ID", {
        deviceUid,
        eventId: outcome.eventId,
      });
      return;
    }
    log.debug("persisted device plugin event", {
      deviceUid,
      eventId: outcome.eventId,
      status: outcome.status,
      kind: event.kind,
    });
  } catch (error) {
    log.warn("failed to persist device plugin event", {
      deviceUid,
      eventId: bytesToUuid(event.id),
      error: (error as Error).message,
    });
    throw error;
  }
}

function isOwnEventTopic(deviceUid: string, topic: string): boolean {
  try {
    const parsed = parseDeviceTopic(topic);
    return parsed.deviceUid === deviceUid && parsed.kind === "event";
  } catch {
    return false;
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
  parsedLog?: LogContainer | LogContainerError,
): Promise<void> {
  try {
    const deviceId = await resolveDeviceId(prisma, deviceUid);
    if (!deviceId) {
      log.warn("ignored log from unknown device", { deviceUid });
      return;
    }
    if (parsedLog instanceof LogContainerError) throw parsedLog;
    const parsed = parsedLog ?? parseLogContainer(payload);
    // bulk path: validate once, resolve the artifact once, insert all
    // elements in a single createMany, one notification for the bundle
    // (a per-element ingest would cost up to ~5 DB round trips per
    // element — the WEB-03 amplification fix)
    const outcome = await ingestLogBundle(prisma, deviceId, parsed.elements);
    const dropped = parsed.dropped + outcome.dropped;
    if (dropped > 0) {
      log.warn("ignored invalid log element(s)", {
        deviceUid,
        dropped,
        reason: "invalid_packet",
      });
    }
    log.debug("ingested device log bundle", {
      deviceUid,
      stored: outcome.stored,
      dropped,
    });
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
    // Write throttle (perf audit): a stat heartbeat with an unchanged
    // hash does not need to rewrite reported_at every time - the rollout
    // stall judgement treats a device as alive within a 1h window, so a
    // 60s write granularity keeps the signal intact while avoiding
    // constant row updates + WAL + autovacuum churn at fleet scale.
    const STAT_WRITE_THROTTLE_MS = 60_000;
    const existing = await prisma.deviceFirmwareState.findUnique({
      where: { deviceId },
      select: { fwHash: true, reportedAt: true },
    });
    const now = new Date();
    const needsWrite =
      !existing ||
      existing.fwHash !== fwHash ||
      now.getTime() - existing.reportedAt.getTime() > STAT_WRITE_THROTTLE_MS;
    if (needsWrite) {
      await prisma.deviceFirmwareState.upsert({
        where: { deviceId },
        update: { fwHash, reportedAt: now },
        create: { deviceId, fwHash },
      });
    }
    log.debug("recorded device firmware state", {
      deviceUid,
      fwHash,
    });
    // OTA fact layer (proposal 18): confirm unconditionally, not only on
    // firmware CHANGE. The redeploy path — a device that already runs the
    // target build ignores the notice and keeps reporting the same hash —
    // would never be confirmed by a change-only guard. confirmOtaTargetByFirmware
    // is idempotent (terminal targets are untouched), so the extra UPDATE
    // per stat is safe and cheap.
    const confirmed = await confirmOtaTargetByFirmware(prisma, deviceId, fwHash);
    if (confirmed > 0) {
      log.info("ota target confirmed by firmware state", {
        deviceUid,
        fwHash,
        confirmed,
      });
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
