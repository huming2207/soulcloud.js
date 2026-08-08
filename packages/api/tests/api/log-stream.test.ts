/**
 * WebSocket log-stream tests (GET /v1/ws/logs).
 *
 * Auth rides the Sec-WebSocket-Protocol header: the client connects with
 * subprotocols ["soulcloud", "<access token>"] and the upgrade is refused
 * (401/404) unless the token is valid and the device belongs to a project
 * the user is a member of.
 *
 * Unlike the other API tests (which use `app.handle`), a real listening
 * socket is required for a WS upgrade: `port: 0` asks Bun for a free
 * random port, reported on `app.server.port` (Elysia 1.4's listen()
 * returns the app instance itself).
 *
 * The hub's pg LISTEN session is a process-wide singleton; afterAll closes
 * it so the listener does not outlive this file (bun test --isolate runs
 * each test file in its own process).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { getLogStreamHub } from "../../src/api/log-stream";
import { LOG_EVENTS_CHANNEL, prisma, signAccessToken } from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

// G group: these endpoints require a logged-in user.
const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);
const server = app.listen({ port: 0, hostname: "127.0.0.1" });
const wsBase = `ws://127.0.0.1:${server.server!.port}`;

let projectId: string;
let deviceId: string;
let otherProjectId: string;
let otherDeviceId: string;
let accessToken = "";
let registeredUserId = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `logstream-user-${randomUUID().slice(0, 8)}`;
  const res = await app.handle(
    new Request("http://localhost/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "test-password-123",
        email: `${username}@example.com`,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return { userId: body.user_id, accessToken: body.access_token };
}

function wsUrl(device: string): string {
  return `${wsBase}/v1/ws/logs?device_id=${device}`;
}

interface WsClient {
  ws: WebSocket;
  messages: string[];
  /** Resolves when the client-side open event fires (upgrade accepted). */
  open: Promise<void>;
  /** Resolves when the socket closes (handshake rejected or closed). */
  closed: Promise<void>;
}

function connectWs(url: string, protocols?: string[]): WsClient {
  const messages: string[] = [];
  let resolveOpen!: () => void;
  let resolveClosed!: () => void;
  const open = new Promise<void>((r) => (resolveOpen = r));
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const ws = new WebSocket(url, protocols);
  ws.onopen = () => resolveOpen();
  ws.onmessage = (ev) => messages.push(String(ev.data));
  ws.onerror = () => {};
  ws.onclose = () => resolveClosed();
  return { ws, messages, open, closed };
}

/** Waits until the connection either opened or closed (or timed out). */
async function waitForSettle(
  client: WsClient,
  timeoutMs = 3000,
): Promise<"open" | "closed" | "timeout"> {
  return Promise.race([
    client.open.then(() => "open" as const),
    client.closed.then(() => "closed" as const),
    Bun.sleep(timeoutMs).then(() => "timeout" as const),
  ]);
}

/** Polls the received messages until one matches; throws after timeout. */
async function waitForMessage<T extends Record<string, unknown>>(
  client: WsClient,
  predicate: (msg: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const raw of client.messages) {
      let parsed: T | null = null;
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        // non-JSON frame; ignore
      }
      if (parsed && predicate(parsed)) return parsed;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for WS message");
    }
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-log-stream-test" } });
  const { userId, accessToken: token } = await registerUser();
  accessToken = token;
  registeredUserId = userId;
  await prisma.userProject.create({ data: { userId, projectId } });

  deviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: deviceId,
      deviceUid: `api-logstream-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-logstream",
      passwordHash: "unused",
      projectId,
    },
  });

  // a device the test user is NOT a member of (handshake must be refused)
  otherProjectId = randomUUID();
  await prisma.project.create({
    data: { id: otherProjectId, name: "api-log-stream-other" },
  });
  otherDeviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: otherDeviceId,
      deviceUid: `api-logstream-other-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-logstream-other",
      passwordHash: "unused",
      projectId: otherProjectId,
    },
  });
});

afterAll(async () => {
  // stop(true): Bun's server.stop() defaults to waiting for active
  // connections, which would hang on lingering WebSockets
  await server.stop(true);
  // close the process-wide LISTEN session (the singleton is reset to null,
  // so a fresh hub is created if anything else subscribes later)
  await (
    await getLogStreamHub(prisma, process.env.DATABASE_URL ?? "", { warn: () => {} })
  ).close();
  await prisma.rawLogEvent.deleteMany({
    where: { deviceId: { in: [deviceId, otherDeviceId] } },
  });
  await prisma.device.deleteMany({ where: { id: { in: [deviceId, otherDeviceId] } } });
  await prisma.project.deleteMany({
    where: { id: { in: [projectId, otherProjectId] } },
  });
  await prisma.$disconnect();
});

describe("GET /v1/ws/logs", () => {
  test("valid token + project member: connects and receives ready", async () => {
    const client = connectWs(wsUrl(deviceId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    const ready = await waitForMessage<{ type: string; device_id?: string }>(
      client,
      (m) => m.type === "ready",
    );
    expect(ready).toMatchObject({ type: "ready", device_id: deviceId });
    client.ws.close();
  });

  test("log event inserted + pg_notify is pushed to the subscriber", async () => {
    const client = connectWs(wsUrl(deviceId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");

    // minimal row (no artifact, raw kept): decode yields tag/message null,
    // exactly the REST shape for an unknown-fw event
    const row = await prisma.rawLogEvent.create({
      data: {
        deviceId,
        deviceTimeMs: 4321n,
        sequence: 9,
        packetType: 0, // LOG
        level: 3,
        rawPacket: new Uint8Array([0x9a, 0x03]),
        decodeState: "unknown_fw",
      },
    });
    const eventId = row.id.toString();

    // NOTIFY is lossy and the hub's LISTEN session starts lazily on the
    // first subscription: re-notify on a short loop until the event arrives
    // (3s deadline) instead of assuming the listener is already up.
    // Payload format: "<deviceId>:<eventId>" (device first so the hub can
    // check subscribers before querying).
    const notifyPayload = `${deviceId}:${eventId}`;
    const deadline = Date.now() + 3000;
    let msg: Record<string, any> | null = null;
    for (;;) {
      await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${notifyPayload})`;
      await Bun.sleep(50);
      msg =
        client.messages
          .map((raw) => {
            try {
              return JSON.parse(raw) as Record<string, any>;
            } catch {
              return null;
            }
          })
          .find((m) => m?.type === "log" && m?.event?.id === eventId) ?? null;
      if (msg) break;
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for WS log event");
      }
    }

    expect(msg).toMatchObject({ type: "log", device_id: deviceId });
    expect(msg!.event.id).toBe(row.id.toString());
    expect(msg!.event.received_at).toBe(row.receivedAt.toISOString());
    expect(msg!.event.device_time_ms).toBe(row.deviceTimeMs.toString());
    expect(msg!.event.sequence).toBe(row.sequence);
    expect(msg!.event.packet_type).toBe(row.packetType);
    expect(msg!.event.level).toBe(row.level);
    expect(msg!.event.tag).toBeNull();
    expect(msg!.event.message).toBeNull();
    expect(msg!.event.decode_state).toBe(row.decodeState);
    client.ws.close();
  });

  test("no subprotocol: handshake rejected", async () => {
    const client = connectWs(wsUrl(deviceId));
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("invalid token: handshake rejected", async () => {
    const client = connectWs(wsUrl(deviceId), [WS_PROTOCOL, "not-a-real-token"]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("device outside the user's projects: handshake rejected", async () => {
    const client = connectWs(wsUrl(otherDeviceId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("unknown device: handshake rejected", async () => {
    const client = connectWs(wsUrl(randomUUID()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("ping -> pong", async () => {
    const client = connectWs(wsUrl(deviceId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.send("ping");
    const pong = await waitForMessage<{ type: string }>(client, (m) => m.type === "pong");
    expect(pong).toEqual({ type: "pong" });
    client.ws.close();
  });

  test("a notify with no subscribers never touches the database", async () => {
    // notify for a device nobody is subscribed to: the hub must check its
    // subscriber map from the payload BEFORE querying (a ghost device also
    // makes the test independent of leftover sockets from earlier tests)
    const ghost = `ghost-${randomUUID()}`;
    const original = prisma.rawLogEvent.findMany;
    let calls = 0;
    prisma.rawLogEvent.findMany = ((...args: unknown[]) => {
      calls += 1;
      return original(...(args as Parameters<typeof original>));
    }) as typeof prisma.rawLogEvent.findMany;
    try {
      await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${`${ghost}:${BigInt(Date.now()).toString()}`})`;
      // give the listener a moment to deliver and (wrongly) query
      await Bun.sleep(300);
      expect(calls).toBe(0);
    } finally {
      prisma.rawLogEvent.findMany = original;
    }
  });

  test("a burst of notifies is merged and delivered whole (debounce)", async () => {
    // fresh hub with a short window: close the singleton, recreate the
    // app with debounceMs 60
    await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    const hub = getLogStreamHub(prisma, "unused", { warn: () => {} });
    // NOTE: the singleton is already the default-window hub; instead use a
    // dedicated app instance created AFTER closing the singleton
    await hub.close();
    const app2 = createApp(prisma, TEST_JWT, 900, { debounceMs: 60 });
    const server2 = app2.listen({ port: 0, hostname: "127.0.0.1" });
    const base2 = `ws://127.0.0.1:${server2.server!.port}`;
    try {
      const client = connectWs(`${base2}/v1/ws/logs?device_id=${deviceId}`, [WS_PROTOCOL, accessToken]);
      expect(await waitForSettle(client)).toBe("open");
      await waitForMessage(client, (m) => m.type === "ready");

      // two events, notified within the 60ms window
      const rows: string[] = [];
      for (let i = 0; i < 2; i++) {
        const row = await prisma.rawLogEvent.create({
          data: {
            deviceId,
            deviceTimeMs: BigInt(1000 + i),
            sequence: i,
            packetType: 0,
            level: 3,
            rawPacket: new Uint8Array([0x9a, 0x03]),
            decodeState: "unknown_fw",
          },
        });
        rows.push(row.id.toString());
        await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${`${deviceId}:${row.id.toString()}`})`;
      }
      const got = new Set<string>();
      await waitForMessage<{ type: string; event?: { id?: unknown } }>(
        client,
        (m) => {
          if (m.type === "log") got.add(String(m.event?.id));
          return got.has(rows[0]!) && got.has(rows[1]!);
        },
        3000,
      );
      expect(got).toEqual(new Set(rows));
      client.ws.close();
    } finally {
      await server2.stop(true);
      await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    }
  });

  test("upper-case device id in the query still receives pushes (normalized key)", async () => {
    // the burst test closed the hub singleton, leaving the original app's
    // hub reference dead; recreate the app with a fresh hub
    await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    const app3 = createApp(prisma, TEST_JWT, 900, { debounceMs: 60 });
    const server3 = app3.listen({ port: 0, hostname: "127.0.0.1" });
    const base3 = `ws://127.0.0.1:${server3.server!.port}`;
    try {
      const upper = deviceId.toUpperCase();
      const client = connectWs(`${base3}/v1/ws/logs?device_id=${upper}`, [WS_PROTOCOL, accessToken]);
      expect(await waitForSettle(client)).toBe("open");
      await waitForMessage(client, (m) => m.type === "ready");
      const row = await prisma.rawLogEvent.create({
        data: {
          deviceId,
          deviceTimeMs: 7n,
          sequence: 42,
          packetType: 0,
          level: 2,
          rawPacket: new Uint8Array([0x9a, 0x03]),
          decodeState: "unknown_fw",
        },
      });
      const deadline = Date.now() + 3000;
      for (;;) {
        await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${`${deviceId}:${row.id.toString()}`})`;
        const seen = client.messages.some((raw) => {
          try {
            const m = JSON.parse(raw) as { type?: string; event?: { id?: unknown } };
            return m.type === "log" && m.event?.id === row.id.toString();
          } catch {
            return false;
          }
        });
        if (seen) break;
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for push to upper-case subscriber");
        }
        await Bun.sleep(50);
      }
      client.ws.close();
    } finally {
      await server3.stop(true);
      await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    }
  });

  test("expired access token: the connection is closed (M2)", async () => {
    await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    // short-lived token + fast expiry check
    const app4 = createApp(prisma, TEST_JWT, 900, {
      debounceMs: 60,
      expCheckIntervalMs: 100,
    });
    const server4 = app4.listen({ port: 0, hostname: "127.0.0.1" });
    const base4 = `ws://127.0.0.1:${server4.server!.port}`;
    try {
      // 1-second TTL token: the expiry check must close the socket
      const shortToken = await signAccessToken(
        { ...TEST_JWT, accessTtlSeconds: 1 },
        { sub: registeredUserId, username: "logstream-user" },
      );
      const client = connectWs(`${base4}/v1/ws/logs?device_id=${deviceId}`, [
        WS_PROTOCOL,
        shortToken,
      ]);
      expect(await waitForSettle(client)).toBe("open");
      // the expiry check closes the socket shortly after the token dies
      const closed = await Promise.race([
        client.closed.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      expect(closed).toBe(true);
      client.ws.close();
      await Bun.sleep(100); // let the server process the close
    } finally {
      // same Bun 1.3.13 quirk as the M3 test: server.stop() hangs when a
      // connection was closed by the server (the 4401 expiry close)
      await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    }
  });

  test("connection cap: a second socket is refused (M3)", async () => {
    await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    const app5 = createApp(prisma, TEST_JWT, 900, {
      debounceMs: 60,
      expCheckIntervalMs: 100,
      maxConnections: 1,
    });
    const server5 = app5.listen({ port: 0, hostname: "127.0.0.1" });
    const base5 = `ws://127.0.0.1:${server5.server!.port}`;
    try {
      const first = connectWs(`${base5}/v1/ws/logs?device_id=${deviceId}`, [
        WS_PROTOCOL,
        accessToken,
      ]);
      expect(await waitForSettle(first)).toBe("open");
      const second = connectWs(`${base5}/v1/ws/logs?device_id=${deviceId}`, [
        WS_PROTOCOL,
        accessToken,
      ]);
      // the cap rejects at subscribe time (after the handshake), so the
      // second socket opens and is then closed by the server
      await waitForSettle(second);
      const closed = await Promise.race([
        second.closed.then(() => true),
        Bun.sleep(2000).then(() => false),
      ]);
      expect(closed).toBe(true);
      first.ws.close();
      second.ws.close();
      await Bun.sleep(100); // let the server process the closes
    } finally {
      // NOTE: server.stop() hangs in Bun 1.3.13 when a connection was
      // closed by the SERVER (the cap's 4401 close here): stop keeps
      // waiting on the server-initiated close. Both sockets are already
      // closed explicitly and the process exits right after the suite,
      // so we skip stop for this server.
      await (await getLogStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
    }
  });
});
