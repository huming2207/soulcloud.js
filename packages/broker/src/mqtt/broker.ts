/**
 * Embedded Aedes MQTT broker factory.
 *
 * The broker is embedded in the API process (single-process architecture):
 * devices connect directly over TCP, authenticate against the `devices`
 * table, and are restricted to their own topics by authorization handlers.
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
import { createServer, type Server } from "node:net";
import type { PrismaClient } from "@soulcloud/core";
import { parseDeviceTopic, TOPIC_PREFIX } from "@soulcloud/core";
export interface BrokerHandle {
  /** The raw Aedes instance (for aedes.publish and event listeners). */
  aedes: Aedes;
  /** TCP server bound to the broker port. */
  server: Server;
  /** Closes the broker and the TCP server. */
  close: () => Promise<void>;
}

/**
 * Creates and starts the embedded MQTT broker on the given port.
 */
export async function startBroker(
  prisma: PrismaClient,
  port: number,
): Promise<BrokerHandle> {
  // Aedes 1.x: createBroker() initialises the broker (including its internal
  // persistence) and starts it; the constructor alone does not fully start.
  const aedes = await Aedes.createBroker();

  aedes.authenticate = (
    _client,
    username,
    password,
    callback,
  ) => {
    authenticateDevice(prisma, username ?? "", password)
      .then((ok) => callback(null, ok))
      .catch((error) =>
        callback(Object.assign(error as Error, { returnCode: 4 }), null),
      );
  };

  // Devices may only publish to their own device-to-platform topics
  // (cmd/result, log, stat). Server-side publishes (client === null) pass.
  aedes.authorizePublish = (client, packet, callback) => {
    if (client === null) {
      callback(null);
      return;
    }
    callback(isAllowedUplink(client, packet.topic) ? null : new Error("topic not allowed"));
  };

  // Devices may only subscribe to topics under their own device prefix.
  aedes.authorizeSubscribe = (client, subscription, callback) => {
    const allowed =
      subscription.topic === `${TOPIC_PREFIX}/${client.id}/#` ||
      subscription.topic.startsWith(`${TOPIC_PREFIX}/${client.id}/`);
    callback(allowed ? null : new Error("topic not allowed"), subscription);
  };

  const server = createServer(aedes.handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });

  return {
    aedes,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          aedes.close();
          resolve();
        });
      }),
  };
}

/**
 * Authenticates a device against the `devices` table.
 *
 * TODO: the password hashing algorithm is an unresolved product decision
 * (same as the Rust version). The current comparison is plaintext and must
 * be replaced once the algorithm is agreed.
 */
async function authenticateDevice(
  prisma: PrismaClient,
  username: string,
  password: Buffer | undefined,
): Promise<boolean> {
  if (!username || password === undefined) return false;
  const device = await prisma.device.findUnique({
    where: { deviceUid: username },
    select: { passwordHash: true },
  });
  if (!device) return false;
  return device.passwordHash === password.toString();
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
