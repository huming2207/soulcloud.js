/**
 * Publishes OTA delivery notices to devices through the embedded Aedes
 * broker (MQTT carries metadata + a per-device download JWT; the device
 * fetches the bin over HTTP itself — see llm-docs/soulcloudjs/17-ota-mqtt-deploy-proposal.md).
 *
 * The poller claims the oldest pending target (SKIP LOCKED, durable
 * outbox semantics like the command poller), checks the device is online,
 * mints a short-lived per-device JWT, publishes the ota message at QoS 1,
 * and marks the target delivered once the broker accepts it. Offline
 * devices are deferred (available_at backoff); targets past their delivery
 * window expire and are never published.
 *
 * ota messages are NEVER retained: a retained notice would be delivered to
 * devices that connect later, re-triggering downloads of stale releases.
 */

import type { Aedes } from "aedes";
import { encode } from "@msgpack/msgpack";
import {
  expireOtaTargets,
  expireStalledOtaTargets,
  leaseNextOtaTarget,
  markOtaTargetDelivered,
  releaseOtaTarget,
  signOtaToken,
  type PrismaClient,
} from "@soulcloud/core";
import { otaCommand } from "@soulcloud/core";

export interface OtaPollerOptions {
  /** HS256 secret for per-device download JWTs. */
  secret: string;
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Lease duration in milliseconds. */
  leaseDurationMs: number;
  /** Download JWT lifetime in seconds. */
  tokenTtlSeconds: number;
  /** Stall window (minutes) before a delivered target is failed (-7). */
  stallTimeoutMinutes: number;
  /** Backoff before an offline-targeted notice becomes claimable again. */
  offlineRetryMs?: number;
}

export interface OtaPollerLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface OtaPoller {
  /** Stops the poller. */
  stop: () => void;
  /** Triggers an immediate poll cycle (lossy wake-up hint). */
  wake: () => void;
}

/**
 * Starts the OTA publication poller (same skeleton as the command poller:
 * fixed interval + lossy wake()).
 */
export function startOtaPoller(
  aedes: Aedes,
  prisma: PrismaClient,
  options: OtaPollerOptions,
  log: OtaPollerLog,
): OtaPoller {
  let running = false;
  let stopped = false;

  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await otaPollOnce(aedes, prisma, options, log);
    } catch (error) {
      log.warn("ota poll cycle failed", {
        error: (error as Error).message,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(poll, options.pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    wake: () => {
      void poll();
    },
  };
}

/** One OTA poll cycle: expire, lease, publish. */
export async function otaPollOnce(
  aedes: Aedes,
  prisma: PrismaClient,
  options: OtaPollerOptions,
  log: OtaPollerLog,
): Promise<void> {
  await expireOtaTargets(prisma);
  const stalled = await expireStalledOtaTargets(prisma, options.stallTimeoutMinutes);
  if (stalled > 0) {
    log.info("ota targets failed by stall timeout", { count: stalled });
  }

  const target = await leaseNextOtaTarget(prisma, options.leaseDurationMs);
  if (!target) return;

  // never publish to an offline device: a QoS1 message to a clean-session
  // client would be broker-dropped and the notice lost. Defer instead —
  // the target retries until its delivery window expires.
  const clients = (aedes as unknown as { clients?: Record<string, unknown> }).clients;
  const online = clients ? target.deviceUid in clients : false;
  if (!online) {
    log.debug("device offline; deferring ota notice", {
      targetId: target.id,
      deviceUid: target.deviceUid,
    });
    await releaseOtaTarget(prisma, target.id, options.offlineRetryMs ?? 5_000);
    return;
  }

  let topic: string;
  try {
    topic = otaCommand(target.deviceUid);
  } catch (error) {
    // unsafe UID cannot form a topic; abandon the target
    log.warn("ota target has an invalid device UID", {
      targetId: target.id,
      deviceUid: target.deviceUid,
      error: (error as Error).message,
    });
    await releaseOtaTarget(prisma, target.id, options.offlineRetryMs ?? 5_000);
    return;
  }

  // Check the subscription, not just the connection: a client can be
  // connected while its SUBSCRIBE is still in flight (esp-mqtt subscribes
  // asynchronously after CONNACK). Publishing to a topic with no
  // subscriber is silently dropped on a clean-session client, yet
  // aedes.publish still resolves and the target gets marked delivered -
  // the notice is then lost forever. Defer until the subscription is
  // registered. client.subscriptions is populated for both clean and
  // persistent sessions (persistence.subscriptionsByTopic only covers
  // the latter).
  const mqttClient = (aedes as unknown as {
    clients?: Record<string, { subscriptions?: Record<string, unknown> }>;
  }).clients?.[target.deviceUid];
  const subscribed = !!mqttClient && !!mqttClient.subscriptions?.[topic];
  if (!subscribed) {
    log.debug("device not subscribed yet; deferring ota notice", {
      targetId: target.id,
      deviceUid: target.deviceUid,
    });
    await releaseOtaTarget(prisma, target.id, 1_000);  // subscription registers within ms
    return;
  }

  const token = await signOtaToken(
    options.secret,
    { deviceUid: target.deviceUid, releaseId: target.releaseId, jobId: target.jobId },
    options.tokenTtlSeconds,
  );
  const expiresAt = new Date(Date.now() + options.tokenTtlSeconds * 1000);

  const download: Record<string, unknown> = {
    url: `/v1/firmware-releases/${target.releaseId}/bin`,
    token,
    expires_at: expiresAt.toISOString(),
  };
  const notice: Record<string, unknown> = {
    release_id: target.releaseId,
    job_id: target.jobId,
    bin_sha256: target.binHash,
    bin_size: target.binSize,
    download,
  };
  if (target.version) notice.version = target.version;

  try {
    topic = otaCommand(target.deviceUid);
  } catch (error) {
    // unsafe UID cannot form a topic; abandon the target
    log.warn("ota target has an invalid device UID", {
      targetId: target.id,
      deviceUid: target.deviceUid,
      error: (error as Error).message,
    });
    await releaseOtaTarget(prisma, target.id, options.offlineRetryMs ?? 5_000);
    return;
  }

  log.debug("publishing ota notice", {
    targetId: target.id,
    deviceUid: target.deviceUid,
    releaseId: target.releaseId,
  });

  try {
    await publishToDevice(aedes, topic, encode(notice));
  } catch (error) {
    log.warn("failed to publish ota notice; releasing target", {
      targetId: target.id,
      deviceUid: target.deviceUid,
      error: (error as Error).message,
    });
    await releaseOtaTarget(prisma, target.id, options.offlineRetryMs ?? 5_000);
    return;
  }

  await markOtaTargetDelivered(prisma, target.id);
  log.info("ota notice broker-accepted", {
    targetId: target.id,
    deviceUid: target.deviceUid,
  });
}

/** Publishes one ota notice via Aedes, resolving on broker acceptance. */
function publishToDevice(
  aedes: Aedes,
  topic: string,
  payload: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    aedes.publish(
      {
        cmd: "publish",
        dup: false,
        topic,
        payload: Buffer.from(payload),
        qos: 1,
        retain: false, // never retain OTA notices (stale-delivery hazard)
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
