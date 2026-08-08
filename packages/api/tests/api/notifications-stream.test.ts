/**
 * Notifications stream tests: ready frame, pg_notify-driven push, all
 * rejection paths, ping/pong and the connection cap. The hub's LISTEN
 * session starts lazily, so pushes are driven by manual pg_notify with
 * a probe-first pattern (lossy channel).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { createAuthRoutes } from "../../src/api/auth";
import { createNotificationsStreamRoutes, getNotificationsHub } from "../../src/api/notifications-stream";
import { NOTIFICATIONS_CHANNEL, prisma } from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

// assemble the app locally: app.ts mounts the stream routes centrally,
// but that mount happens in the parent's merge - tests stay independent
const app = new Elysia()
  .use(createAuthRoutes(prisma, TEST_JWT))
  .use(createNotificationsStreamRoutes(prisma, TEST_JWT));
const server = app.listen({ port: 0, hostname: "127.0.0.1" });
const wsBase = `ws://127.0.0.1:${server.server!.port}`;

let projectId: string;
let otherProjectId: string;
let accessToken = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `notify-user-${randomUUID().slice(0, 8)}`;
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
  return `${wsBase}/v1/ws/notifications?project_id=${project}`;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-notify-test" } });
  const { userId, accessToken: token } = await registerUser();
  accessToken = token;
  await prisma.userProject.create({ data: { userId, projectId } });

  otherProjectId = randomUUID();
  await prisma.project.create({
    data: { id: otherProjectId, name: "api-notify-other" },
  });
});

afterAll(async () => {
  server.stop();
  await (await getNotificationsHub("unused", { warn: () => {} })).close().catch(() => {});
  await prisma.userProject.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.$disconnect();
});

describe("GET /v1/ws/notifications", () => {
  test("valid token + member: connects, receives ready and pushed notifications", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    await waitForMessage(client, (m) => m.type === "ready");

    // the hub's LISTEN starts lazily: probe with a throwaway notification
    const probe = JSON.stringify({
      type: "completed",
      rollout_id: randomUUID(),
      project_id: projectId,
    });
    const probeDeadline = Date.now() + 3000;
    for (;;) {
      await prisma.$executeRaw`SELECT pg_notify(${NOTIFICATIONS_CHANNEL}, ${probe})`;
      const seen = client.messages.some((raw) => {
        try {
          const m = JSON.parse(raw) as { type?: string; notification?: { rollout_id?: string } };
          return m.type === "notification" && m.notification?.rollout_id !== undefined;
        } catch {
          return false;
        }
      });
      if (seen) break;
      if (Date.now() >= probeDeadline) {
        throw new Error("listener never came up (no notification frame)");
      }
      await Bun.sleep(50);
    }
    client.messages.length = 0;

    // a real event is delivered to the project's subscribers
    const rolloutId = randomUUID();
    const payload = JSON.stringify({
      type: "manual_approval",
      rollout_id: rolloutId,
      project_id: projectId,
    });
    await prisma.$executeRaw`SELECT pg_notify(${NOTIFICATIONS_CHANNEL}, ${payload})`;
    const msg = await waitForMessage<{
      type: string;
      notification: { type: string; rollout_id: string; project_id: string };
    }>(
      client,
      // match the real event by rollout id: probe frames may still be in
      // flight when the listener backlog drains
      (m) => m.type === "notification" && m.notification?.rollout_id === rolloutId,
    );
    expect(msg.notification).toEqual({
      type: "manual_approval",
      rollout_id: rolloutId,
      project_id: projectId,
    });

    client.ws.close();
    await Bun.sleep(100);
  });

  test("no subprotocol: handshake rejected", async () => {
    const client = connectWs(wsUrl(projectId));
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("invalid token: handshake rejected", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, "not-a-real-token"]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("project outside the user's membership: handshake rejected", async () => {
    const client = connectWs(wsUrl(otherProjectId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("unknown project: handshake rejected", async () => {
    const client = connectWs(wsUrl(randomUUID()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("ping -> pong", async () => {
    const client = connectWs(wsUrl(projectId), [WS_PROTOCOL, accessToken]);
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.send("ping");
    await waitForMessage(client, (m) => m.type === "pong");
    client.ws.close();
    await Bun.sleep(100);
  });

  test("connection cap: a second socket is refused (M3)", async () => {
    await (await getNotificationsHub("unused", { warn: () => {} })).close().catch(() => {});
    const app2 = new Elysia()
      .use(createAuthRoutes(prisma, TEST_JWT))
      .use(createNotificationsStreamRoutes(prisma, TEST_JWT, { maxConnections: 1 }));
    const server2 = app2.listen({ port: 0, hostname: "127.0.0.1" });
    const base2 = `ws://127.0.0.1:${server2.server!.port}`;
    try {
      const first = connectWs(`${base2}/v1/ws/notifications?project_id=${projectId}`, [
        WS_PROTOCOL,
        accessToken,
      ]);
      expect(await waitForSettle(first)).toBe("open");
      const second = connectWs(`${base2}/v1/ws/notifications?project_id=${projectId}`, [
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
      await Bun.sleep(100);
    } finally {
      // Bun 1.3.13: server.stop() hangs after a server-initiated close;
      // sockets are closed explicitly, the process cleans up the rest
      await (await getNotificationsHub("unused", { warn: () => {} })).close().catch(() => {});
    }
  });
});
