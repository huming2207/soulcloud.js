/**
 * Embedded Aedes MQTT broker factory.
 *
 * The broker runs in its own process and serves devices over MQTT over
 * WebSocket only (raw TCP was removed in the S8 audit fix; TLS termination
 * is expected to be provided by a reverse proxy in front of the WS path).
 * Devices authenticate against the `devices` table and are restricted to
 * their own topics by authorization handlers.
 *
 * Key Aedes behaviors verified in the phase-0 spike:
 *   - `aedes.publish()` callback success IS broker acceptance; no external
 *     PUBACK round-trip is needed
 *   - `authorizePublish` receives `client === null` for server-side
 *     publishes and MUST allow them
 *   - a rejected publish disconnects the offending client (no error is
 *     returned to the publish callback)
 */

import { Aedes, type Client } from "aedes";
import type { PrismaClient } from "@soulcloud/core";
import {
  isValidDeviceUid,
  parseDeviceTopic,
  TOPIC_PREFIX,
  verifyDevicePassword,
} from "@soulcloud/core";
import { startWsBroker, type WsBrokerHandle } from "./ws-adapter";

/** Delay before answering a failed authentication attempt. */
const AUTH_FAIL_DELAY_MS = 100;

/**
 * Bounded semaphore for CPU-bound device authentication (Argon2id).
 *
 * Argon2id is deliberately expensive; a reconnect burst or a hostile device
 * farm could otherwise pin every core on password hashing before any rate
 * limiter gets a chance to act. `acquire` resolves with a release function
 * ONLY when a slot is granted — queued callers must not start hashing
 * before that — and refuses (null) instead of growing unbounded when the
 * queue saturates.
 */
export class AuthSemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
  ) {}

  /**
   * Resolves to a release function once a slot is granted (immediately for
   * the first `limit` callers, later for queued ones), or null when the
   * queue is saturated. The release function must be called exactly once
   * when the critical section finishes.
   */
  acquire(): Promise<(() => void) | null> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.waiters.length >= this.queueLimit) return Promise.resolve(null);
    return new Promise((resolve) => {
      // grant hands the slot to this waiter when a slot frees up
      this.waiters.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    this.active--;
    const grant = this.waiters.shift();
    if (grant) {
      // hand the freed slot to the next waiter; its release() decrements
      // again when that attempt finishes
      this.active++;
      grant();
    }
  }
}

/**
 * Kills a device's live MQTT session (credential revocation).
 *
 * aedes exposes `clients` as a plain object keyed by clientId; with the
 * S1/S2 identity binding the clientId IS the device UID. The client's
 * `close()` tears down the connection; on reconnect the revoked credential
 * is refused by authenticate.
 */
export function kickDeviceSession(aedes: Aedes, deviceUid: string): boolean {
  const clients = (aedes as unknown as { clients?: Record<string, Client> }).clients;
  const client = clients?.[deviceUid];
  if (!client) return false; // not connected
  client.close();
  return true;
}

/** Absolute upper bound for a device publish (MQTT spec allows 256MB; the
 * dispatch layer applies the configurable UPLINK_MAX_PACKET_BYTES limit,
 * this is the early-reject ceiling before dispatch runs). */
const MAX_PUBLISH_BYTES = 256 * 1024;
export interface BrokerHandle {
  /** The raw Aedes instance (for aedes.publish and event listeners). */
  aedes: Aedes;
  /** WebSocket server bound to the broker port. */
  server: WsBrokerHandle["server"];
  /** Closes the broker and the WebSocket server. */
  close: () => Promise<void>;
}

export interface StartBrokerOptions {
  /** WS listen port. */
  port: number;
  /** WS path, e.g. "/mqtt". */
  path?: string;
  /** Max concurrent Argon2id auth verifications (default 8). */
  authConcurrency?: number;
}

/**
 * Creates and starts the embedded MQTT-over-WebSocket broker.
 */
export async function startBroker(
  prisma: PrismaClient,
  options: StartBrokerOptions,
): Promise<BrokerHandle> {
  const { port, path = "/mqtt" } = options;
  // Aedes 1.x: createBroker() initialises the broker (including its internal
  // persistence) and starts it; the constructor alone does not fully start.
  const aedes = await Aedes.createBroker();
  // CPU-bound auth guard (WEB-09): bounded concurrency so a reconnect burst
  // cannot pin every core on Argon2id. Default 8; configured via
  // BROKER_AUTH_CONCURRENCY. Queue cap = 4x limit, then refuse immediately.
  const authGate = new AuthSemaphore(
    options.authConcurrency ?? 8,
    (options.authConcurrency ?? 8) * 4,
  );

  // Identity binding (S1/S2): the MQTT clientId MUST equal the username
  // (the device UID), and the clientId must be a valid device UID. All
  // authorization below trusts client.id; without this binding any holder
  // of one device's credentials could impersonate any other device.
  aedes.authenticate = (client, username, password, callback) => {
    if (!username || client.id !== username || !isValidDeviceUid(client.id)) {
      callback(null, false);
      return;
    }
    void authGate.acquire().then((release) => {
      if (!release) {
        // auth queue saturated: refuse now; the device retries (MQTT spec
        // allows the client to reconnect). Refusing beats unbounded queuing.
        callback(null, false);
        return;
      }
      authenticateDevice(prisma, username, password)
        .then(async (ok) => {
          if (!ok) {
            // M6: fixed delay on auth failure (cheap brute-force throttle;
            // a real rate limiter belongs in the reverse proxy)
            await new Promise((r) => setTimeout(r, AUTH_FAIL_DELAY_MS));
          }
          callback(null, ok);
        })
        .catch((error) => {
          // database failure is a server problem, not bad credentials:
          // returnCode 3 (server unavailable) so clients do not stop retrying
          callback(Object.assign(error as Error, { returnCode: 3 }), null);
        })
        .finally(release);
    });
  };

  // Devices may only publish to their own device-to-platform topics
  // (cmd/result, log, stat). Server-side publishes (client === null) pass.
  // Packet size is checked here (before the full payload is buffered further)
  // as an early DoS guard; dispatch re-checks with the configured limit.
  aedes.authorizePublish = (client, packet, callback) => {
    if (client === null) {
      callback(null);
      return;
    }
    const size = packet.payload?.length ?? 0;
    if (size > MAX_PUBLISH_BYTES) {
      callback(new Error("packet too large"));
      return;
    }
    callback(isAllowedUplink(client, packet.topic) ? null : new Error("topic not allowed"));
  };

  // Direction separation (spec 06): devices may only subscribe to their own
  // DOWNLINK topics (cmd/exec, ota). Subscribing to their own uplink topics
  // (log/stat/cmd/result) would echo their own reports back to them.
  const DOWNLINK_SUFFIXES = ["cmd/exec", "ota"] as const;
  aedes.authorizeSubscribe = (client, subscription, callback) => {
    const allowed = DOWNLINK_SUFFIXES.some(
      (suffix) => subscription.topic === `${TOPIC_PREFIX}/${client.id}/${suffix}`,
    );
    callback(allowed ? null : new Error("topic not allowed"), subscription);
  };

  const { server } = await startWsBroker(aedes, {
    port,
    path,
    // the pre-scan ceiling matches authorizePublish's MAX_PUBLISH_BYTES
    maxPacketBytes: MAX_PUBLISH_BYTES,
  });

  return {
    aedes,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.stop(true);
        } catch {
          // already stopped
        }
        aedes.close();
        resolve();
      }),
  };
}

/**
 * Authenticates a device against the `devices` table.
 *
 * Passwords are argon2id-hashed (Bun.password); no legacy formats are
 * accepted (scrypt/plaintext compatibility was removed by user decision).
 * Exported for unit tests (mock prisma); the broker wires it into
 * aedes.authenticate with a returnCode-3 mapping on DB failures.
 */
export async function authenticateDevice(
  prisma: PrismaClient,
  username: string,
  password: Buffer | undefined,
): Promise<boolean> {
  if (!username || password === undefined) return false;
  const device = await prisma.device.findUnique({
    where: { deviceUid: username },
    select: { passwordHash: true, authRevoked: true },
  });
  if (!device) return false;
  // G group: revoked credentials refuse new connections (live sessions are
  // killed via the CREDENTIAL_REVOKED notify + kickDeviceSession)
  if (device.authRevoked) return false;
  return verifyDevicePassword(password.toString(), device.passwordHash);
}

/** Whether a device may publish to the given topic (uplink kinds only). */
function isAllowedUplink(client: Client, topic: string): boolean {
  try {
    const parsed = parseDeviceTopic(topic);
    return parsed.deviceUid === client.id;
  } catch {
    return false;
  }
}
