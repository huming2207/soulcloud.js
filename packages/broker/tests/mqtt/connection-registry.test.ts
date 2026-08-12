/**
 * Tests for the connection registry (src/mqtt/connection-registry.ts):
 * the broker-owned lookup of live device sessions and subscriptions that
 * replaces the previous reads of aedes' internal `clients` /
 * `client.subscriptions` structures.
 *
 * Uses a bare Aedes (no authenticate/authorize gates) so the tests
 * exercise the registry events only; the ACL integration lives in
 * broker.test.ts / publish.test.ts / ota-publish.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Aedes } from "aedes";
import { attachConnectionRegistry, type ConnectionRegistry } from "../../src/mqtt/connection-registry";
import { startWsBroker, type WsBrokerHandle } from "../../src/mqtt/ws-adapter";
import { MqttTestClient } from "../helpers/mqtt-client";

const DEVICE_UID = `registry-test-${Math.random().toString(36).slice(2, 10)}`;
const OTHER_UID = `registry-other-${Math.random().toString(36).slice(2, 10)}`;
const TOPIC = `soulcloud/v1/devices/${DEVICE_UID}/cmd/exec`;

let aedes: Aedes;
let registry: ConnectionRegistry;
let server: WsBrokerHandle;
let url: string;

function clientFor(uid: string): MqttTestClient {
  return new MqttTestClient(url, { clientId: uid, username: uid, password: "secret" });
}

async function waitForConnect(client: MqttTestClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

beforeAll(async () => {
  aedes = await Aedes.createBroker();
  registry = attachConnectionRegistry(aedes);
  // Mirror the broker.ts wiring: allow only the device's own cmd/exec
  // topic and record authorized subscriptions in the registry (the
  // persistent-session restore path re-runs this gate).
  aedes.authorizeSubscribe = (client, subscription, callback) => {
    const allowed = subscription.topic === `soulcloud/v1/devices/${client.id}/cmd/exec`;
    if (allowed) {
      registry.noteAuthorizedSubscription(client.id, subscription.topic);
    }
    callback(allowed ? null : new Error("topic not allowed"), subscription);
  };
  server = await startWsBroker(aedes, { port: 0, path: "/mqtt" });
  url = `ws://127.0.0.1:${server.port}/mqtt`;
});

afterAll(async () => {
  server.server.stop(true);
  aedes.close();
});

describe("connection registry", () => {
  test("tracks connect and disconnect by device uid", async () => {
    expect(registry.isConnected(DEVICE_UID)).toBe(false);
    const client = clientFor(DEVICE_UID);
    void client.connect().catch(() => {});
    await waitForConnect(client);
    expect(registry.isConnected(DEVICE_UID)).toBe(true);
    expect(registry.isConnected(OTHER_UID)).toBe(false);
    expect(registry.size).toBe(1);

    client.end();
    await waitFor(() => !registry.isConnected(DEVICE_UID), "disconnect");
    expect(registry.size).toBe(0);
  });

  test("tracks subscriptions, including unsubscribe", async () => {
    const client = clientFor(DEVICE_UID);
    void client.connect().catch(() => {});
    await waitForConnect(client);

    expect(registry.isSubscribed(DEVICE_UID, TOPIC)).toBe(false);
    await client.subscribe(TOPIC);
    await waitFor(() => registry.isSubscribed(DEVICE_UID, TOPIC), "subscribe");

    // other devices / other topics must not match
    expect(registry.isSubscribed(OTHER_UID, TOPIC)).toBe(false);
    expect(registry.isSubscribed(DEVICE_UID, `${TOPIC}/nope`)).toBe(false);

    await client.unsubscribe([TOPIC]);
    await waitFor(() => !registry.isSubscribed(DEVICE_UID, TOPIC), "unsubscribe");
    client.end();
  });

  test("same-clientId replacement keeps one live entry (the new session)", async () => {
    const first = clientFor(DEVICE_UID);
    void first.connect().catch(() => {});
    await waitForConnect(first);
    const firstSession = registry.getClient(DEVICE_UID);
    expect(firstSession).not.toBeNull();

    // a second connect with the same clientId: aedes closes the old
    // session and registers the replacement
    const second = clientFor(DEVICE_UID);
    void second.connect().catch(() => {});
    await waitForConnect(second);

    await waitFor(
      () => registry.getClient(DEVICE_UID) !== firstSession,
      "replacement registration",
    );
    expect(registry.isConnected(DEVICE_UID)).toBe(true);
    expect(registry.size).toBe(1);

    second.end();
    await waitFor(() => !registry.isConnected(DEVICE_UID), "final disconnect");
  });

  test("getClient returns the live session for kicks and null when offline", async () => {
    expect(registry.getClient(OTHER_UID)).toBeNull();
    const client = clientFor(OTHER_UID);
    void client.connect().catch(() => {});
    await waitForConnect(client);
    const live = registry.getClient(OTHER_UID);
    expect(live).not.toBeNull();
    // the returned object is a real aedes client: closing it kicks the
    // device (the registry then observes the disconnect event)
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    live!.close();
    await closed;
    await waitFor(() => !registry.isConnected(OTHER_UID), "kick disconnect");
    expect(registry.getClient(OTHER_UID)).toBeNull();
  });

  test("persistent session (clean=false) restores subscriptions on reconnect", async () => {
    // First connect: persistent session + explicit subscribe.
    const first = new MqttTestClient(url, {
      clientId: DEVICE_UID,
      username: DEVICE_UID,
      password: "secret",
      clean: false,
    });
    void first.connect().catch(() => {});
    await waitForConnect(first);
    await first.subscribe(TOPIC);
    await waitFor(() => registry.isSubscribed(DEVICE_UID, TOPIC), "initial subscribe");
    first.end();
    await waitFor(() => !registry.isConnected(DEVICE_UID), "first disconnect");
    expect(registry.isSubscribed(DEVICE_UID, TOPIC)).toBe(false);

    // Reconnect WITHOUT re-subscribing: aedes restores the saved
    // subscription through the authorizeSubscribe gate (no 'subscribe'
    // event fires on the restore path), and the registry must learn it
    // via noteAuthorizedSubscription + the pending buffer.
    const second = new MqttTestClient(url, {
      clientId: DEVICE_UID,
      username: DEVICE_UID,
      password: "secret",
      clean: false,
    });
    void second.connect().catch(() => {});
    await waitForConnect(second);
    await waitFor(() => registry.isSubscribed(DEVICE_UID, TOPIC), "restored subscription");
    second.end();
    await waitFor(() => !registry.isConnected(DEVICE_UID), "final disconnect");
  });

  test("rejected subscriptions never enter the registry", async () => {
    const client = clientFor(DEVICE_UID);
    void client.connect().catch(() => {});
    await waitForConnect(client);

    // the gate rejects anything but the device's own cmd/exec topic
    const forbidden = `soulcloud/v1/devices/${OTHER_UID}/cmd/exec`;
    await expect(client.subscribe(forbidden)).rejects.toThrow();
    // aedes disconnects the offender on authorization failure
    await waitFor(() => !registry.isConnected(DEVICE_UID), "offender disconnect");
    expect(registry.isSubscribed(DEVICE_UID, forbidden)).toBe(false);
  });
});
