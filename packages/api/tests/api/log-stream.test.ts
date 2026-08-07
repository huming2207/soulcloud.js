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
import { LOG_EVENTS_CHANNEL, prisma } from "@soulcloud/core";

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
    const deadline = Date.now() + 3000;
    let msg: Record<string, any> | null = null;
    for (;;) {
      await prisma.$executeRaw`SELECT pg_notify(${LOG_EVENTS_CHANNEL}, ${eventId})`;
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
});
