/**
 * WebSocket device-status stream tests (GET /v1/ws/status).
 *
 * Auth rides the Sec-WebSocket-Protocol header: the client connects with
 * subprotocols ["soulcloud", "<access token>"] and the upgrade is refused
 * (401/404) unless the token is valid and the project belongs to the
 * user. A real listening socket is required for the WS upgrade
 * (`port: 0` -> a free random port).
 *
 * The hub's pg LISTEN session is a process-wide singleton; afterAll
 * closes it (bun test --isolate runs each file in its own process).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { getStatusStreamHub } from "../../src/api/status-stream";
import { DEVICE_STATUS_CHANNEL, prisma } from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);
const server = app.listen({ port: 0, hostname: "127.0.0.1" });
const wsBase = `ws://127.0.0.1:${server.server!.port}`;

let projectId: string;
let otherProjectId: string;
let deviceUid: string;
let accessToken = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `status-user-${randomUUID().slice(0, 8)}`;
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

interface WsClient {
  ws: WebSocket;
  messages: string[];
  open: Promise<void>;
  closed: Promise<void>;
  closeCode: number;
}

function connectWs(url: string, protocols?: string[]): WsClient {
  const messages: string[] = [];
  let resolveOpen!: () => void;
  let resolveClosed!: () => void;
  const open = new Promise<void>((r) => (resolveOpen = r));
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let closeCode = 0;
  const ws = new WebSocket(url, protocols);
  ws.onopen = () => resolveOpen();
  ws.onmessage = (ev) => messages.push(String(ev.data));
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    closeCode = ev.code;
    resolveClosed();
  };
  return { ws, messages, open, closed, closeCode };
}

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
        continue;
      }
      if (parsed && predicate(parsed)) return parsed;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for WS message");
    }
    await Bun.sleep(25);
  }
}

function wsUrl(project: string): string {
  return `${wsBase}/v1/ws/status?project_id=${project}`;
}

/** Notifies the status channel as the broker would. */
async function notifyStatus(uid: string, online: boolean): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify(${DEVICE_STATUS_CHANNEL}, ${JSON.stringify({ online, uid })})`;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-status-stream" } });
  const { userId, accessToken: token } = await registerUser();
  accessToken = token;
  await prisma.userProject.create({ data: { userId, projectId } });

  deviceUid = `status-${randomUUID().slice(0, 8)}`;
  await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-status",
      passwordHash: "unused",
      projectId,
    },
  });

  // a project the test user is NOT a member of (handshake must be refused)
  otherProjectId = randomUUID();
  await prisma.project.create({
    data: { id: otherProjectId, name: "api-status-other" },
  });
});

afterAll(async () => {
  await (await getStatusStreamHub(prisma, "unused", { warn: () => {} })).close().catch(() => {});
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.userProject.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.$disconnect();
});

describe("GET /v1/ws/status", () => {
  test("valid token + project member: connects, receives ready", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.close();
    await Bun.sleep(50);
  });

  test("online/offline notifies are pushed with the resolved project", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");

    // the hub's LISTEN starts lazily on first subscribe; pg_notify is
    // lossy, so probe until the listener is confirmed up
    const probeDeadline = Date.now() + 3000;
    for (;;) {
      await notifyStatus(deviceUid, true);
      const probed = client.messages.some((raw) => {
        try {
          const m = JSON.parse(raw) as { type?: string; device_uid?: unknown };
          return m.type === "status" && m.device_uid === deviceUid;
        } catch {
          return false;
        }
      });
      if (probed) break;
      if (Date.now() >= probeDeadline) {
        throw new Error("listener never came up (no status frame received)");
      }
      await Bun.sleep(50);
    }
    // the probe's debounce timer may still flush a duplicate; wait it out
    await Bun.sleep(120);
    client.messages.length = 0;

    await notifyStatus(deviceUid, false);
    const msg = await waitForMessage<{
      type: string;
      device_uid?: unknown;
      online?: unknown;
      ts?: unknown;
    }>(
      client,
      (m) => m.type === "status" && m.device_uid === deviceUid && m.online === false,
    );
    expect(msg.device_uid).toBe(deviceUid);
    expect(msg.online).toBe(false);
    expect(typeof msg.ts).toBe("number");
    client.ws.close();
    await Bun.sleep(50);
  });

  test("a new subscriber receives the current known state", async () => {
    // establish a known state first (listener already up from prior test
    // in this file; notify until the state is recorded is not observable
    // without a subscriber, so just notify and wait a debounce window)
    await notifyStatus(deviceUid, true);
    await Bun.sleep(400);

    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    // initial replay includes the known online state (resolveAndPush
    // records even with zero subscribers, so the value is the real one)
    const replayed = await waitForMessage<{
      type: string;
      device_uid?: unknown;
      online?: unknown;
    }>(client, (m) => m.type === "status" && m.device_uid === deviceUid);
    expect(replayed.online).toBe(true);
    client.ws.close();
    await Bun.sleep(50);
  });

  test("unknown devices do not produce frames", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    const ghostUid = `ghost-${randomUUID().slice(0, 8)}`;
    await notifyStatus(ghostUid, true);
    await Bun.sleep(400);
    // only ghost frames count: the connection legitimately replays the
    // known state of real devices from earlier tests
    const ghostFrames = client.messages.filter((raw) => {
      try {
        const m = JSON.parse(raw) as { type?: string; device_uid?: unknown };
        return m.type === "status" && m.device_uid === ghostUid;
      } catch {
        return false;
      }
    });
    expect(ghostFrames).toHaveLength(0);
    client.ws.close();
    await Bun.sleep(50);
  });

  test("no subprotocol: handshake rejected", async () => {
    const client = connectWs(wsUrl(projectId));
    expect(await waitForSettle(client)).toBe("closed");
    client.ws.close();
  });

  test("invalid token: handshake rejected", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, "not-a-real-token"]);
    expect(await waitForSettle(client)).toBe("closed");
    client.ws.close();
  });

  test("project outside the user's membership: handshake rejected", async () => {
    const client = connectWs(wsUrl(otherProjectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
    client.ws.close();
  });

  test("unknown project: handshake rejected", async () => {
    const client = connectWs(wsUrl(randomUUID()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
    client.ws.close();
  });

  test("ping -> pong", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.send("ping");
    await waitForMessage(client, (m) => m.type === "pong");
    client.ws.close();
    await Bun.sleep(50);
  });
});
