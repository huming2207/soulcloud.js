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

  // Identity binding (S1/S2): the MQTT clientId MUST equal the username
  // (the device UID), and the clientId must be a valid device UID. All
  // authorization below trusts client.id; without this binding any holder
  // of one device's credentials could impersonate any other device.
  aedes.authenticate = (client, username, password, callback) => {
    if (!username || client.id !== username || !isValidDeviceUid(client.id)) {
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

  const { server } = await startWsBroker(aedes, { port, path });

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
 * Passwords are stored scrypt-hashed (constant-time verification); legacy
 * plaintext hashes are still accepted for development data but never
 * written going forward.
 */
async function authenticateDevice(
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
  // G group: revoked credentials refuse new connections (an already-open
  // session keeps running until it disconnects; documented limitation)
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
