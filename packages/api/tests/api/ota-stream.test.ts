/**
 * WebSocket OTA stream tests (GET /v1/ws/ota).
 *
 * Auth rides the Sec-WebSocket-Protocol header: the client connects with
 * subprotocols ["soulcloud", "<access token>"] and the upgrade is refused
 * (401/404) unless the token is valid and the job belongs to a project
 * the user is a member of.
 *
 * Like log-stream.test.ts, a real listening socket is required for a WS
 * upgrade: `port: 0` asks Bun for a free random port, reported on
 * `app.server.port` (Elysia 1.4's listen() returns the app instance).
 *
 * The hub's pg LISTEN session is a process-wide singleton; afterAll closes
 * it so the listener does not outlive this file (bun test --isolate runs
 * each test file in its own process).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { getOtaStreamHub } from "../../src/api/ota-stream";
import { createOtaJob, OTA_NOTIFY_CHANNEL, prisma } from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

// G group: these endpoints require a logged-in user.
const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT, undefined, { debounceMs: 25 });
const server = app.listen({ port: 0, hostname: "127.0.0.1" });
const wsBase = `ws://127.0.0.1:${server.server!.port}`;

let projectId: string;
let otherProjectId: string;
let jobId = "";
let otherJobId = "";
let targetId = "";
let releaseId = "";
let deviceId = "";
let accessToken = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `otastream-user-${randomUUID().slice(0, 8)}`;
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

function wsUrl(job: string): string {
  return `${wsBase}/v1/ws/ota?job_id=${job}`;
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

/**
 * NOTIFY is lossy and the hub's LISTEN session starts lazily on the first
 * subscription: re-notify on a short loop until a matching update arrives
 * (3s deadline) instead of assuming the listener is already up.
 */
async function notifyUntil(
  client: WsClient,
  job: string,
  predicate: (msg: Record<string, any>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${job})`;
    await Bun.sleep(50);
    const msg = client.messages
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, any>;
        } catch {
          return null;
        }
      })
      .find((m) => m && predicate(m));
    if (msg) return msg;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for WS ota update");
    }
  }
}

/** True if the raw frame is an ota push ({ type: "ota" }). */
function isOtaFrame(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { type?: string }).type === "ota";
  } catch {
    return false;
  }
}

/** Polls until at least `count` ota frames have been received. */
async function waitForFrameCount(
  client: WsClient,
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (client.messages.filter(isOtaFrame).length >= count) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${count} ota frames`);
    }
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-ota-stream-test" } });
  const { userId, accessToken: token } = await registerUser();
  accessToken = token;
  await prisma.userProject.create({ data: { userId, projectId } });

  deviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: deviceId,
      deviceUid: `api-otastream-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-otastream",
      passwordHash: "unused",
      projectId,
    },
  });
  releaseId = randomUUID();
  await prisma.firmwareRelease.create({
    data: {
      id: releaseId,
      projectId,
      binHash: createHash("sha256").update("ota-stream-test").digest("hex"),
      binBytes: new Uint8Array([0x01, 0x02, 0x03]),
      binSize: 3,
    },
  });

  const job = await createOtaJob(prisma, {
    projectId,
    releaseId,
    createdBy: userId,
    deviceIds: [deviceId],
    targetTtlSeconds: 900,
  });
  jobId = job.jobId;
  const target = await prisma.otaTarget.findFirstOrThrow({ where: { jobId } });
  targetId = target.id;

  // a job the test user is NOT a member of (handshake must be refused)
  otherProjectId = randomUUID();
  await prisma.project.create({
    data: { id: otherProjectId, name: "api-ota-stream-other" },
  });
  const otherDeviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: otherDeviceId,
      deviceUid: `api-otastream-other-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-otastream-other",
      passwordHash: "unused",
      projectId: otherProjectId,
    },
  });
  const otherReleaseId = randomUUID();
  await prisma.firmwareRelease.create({
    data: {
      id: otherReleaseId,
      projectId: otherProjectId,
      binHash: createHash("sha256").update("ota-stream-other").digest("hex"),
      binBytes: new Uint8Array([0x04, 0x05, 0x06]),
      binSize: 3,
    },
  });
  const otherJob = await createOtaJob(prisma, {
    projectId: otherProjectId,
    releaseId: otherReleaseId,
    createdBy: userId,
    deviceIds: [otherDeviceId],
    targetTtlSeconds: 900,
  });
  otherJobId = otherJob.jobId;
});

afterAll(async () => {
  // stop(true): Bun's server.stop() defaults to waiting for active
  // connections, which would hang on lingering WebSockets
  await server.stop(true);
  // close the process-wide LISTEN session (the singleton is reset to null,
  // so a fresh hub is created if anything else subscribes later)
  await (
    await getOtaStreamHub(prisma, process.env.DATABASE_URL ?? "", { warn: () => {} })
  ).close();
  await prisma.otaTarget.deleteMany({
    where: { job: { projectId: { in: [projectId, otherProjectId] } } },
  });
  await prisma.otaJob.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.firmwareRelease.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.device.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.project.deleteMany({
    where: { id: { in: [projectId, otherProjectId] } },
  });
  await prisma.$disconnect();
});

describe("GET /v1/ws/ota", () => {
  test("valid token + project member: connects and receives ready", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    const ready = await waitForMessage<{ type: string; job_id?: string }>(
      client,
      (m) => m.type === "ready",
    );
    expect(ready).toMatchObject({ type: "ready", job_id: jobId });
    client.ws.close();
  });

  test("pg_notify(soulcloud_ota, jobId) is pushed as an ota update (REST shape)", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");

    // advance the target so the push reflects a real state change
    const deliveredAt = new Date();
    await prisma.otaTarget.update({
      where: { id: targetId },
      data: { state: "delivered", deliveredAt },
    });

    const msg = await notifyUntil(
      client,
      jobId,
      (m) => m?.type === "ota" && m?.job_id === jobId,
    );

    expect(msg).toMatchObject({ type: "ota", job_id: jobId, release_id: releaseId });
    expect(msg!.created_at).toBe(
      (await prisma.otaJob.findUniqueOrThrow({ where: { id: jobId } })).createdAt.toISOString(),
    );
    expect(msg!.state).toBe("running");
    expect(msg!.targets).toHaveLength(1);
    expect(msg!.targets[0]).toMatchObject({
      device_id: deviceId,
      state: "delivered",
      delivered_at: deliveredAt.toISOString(),
      confirmed_at: null,
      result_code: null,
      result_message: null,
      current_fw: null,
    });
    expect(msg!.targets[0].device_uid).toMatch(/^api-otastream-/);
    expect(msg!.summary).toEqual({ delivered: 1 });

    // a terminal target flips the derived job state to "completed"
    await prisma.otaTarget.update({
      where: { id: targetId },
      data: { state: "completed", confirmedAt: new Date(), resultCode: 0, resultMessage: "ok" },
    });
    const done = await notifyUntil(
      client,
      jobId,
      (m) => m?.type === "ota" && m?.job_id === jobId && m?.state === "completed",
    );
    expect(done.targets[0].state).toBe("completed");
    expect(done.targets[0].result_code).toBe(0);
    expect(done.summary).toEqual({ completed: 1 });
    client.ws.close();
  });

  test("notifies inside the debounce window merge into one push; a post-window notify pushes again", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    // probe until the lazy LISTEN session is confirmed up
    await notifyUntil(client, jobId, (m) => m?.type === "ota" && m?.job_id === jobId);
    // let any in-flight debounce from the probe settle before counting
    await Bun.sleep(100);

    const frameCount = () => client.messages.filter(isOtaFrame).length;
    const before = frameCount();

    // a) two notifies inside the debounce window (25ms) -> one merged frame
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await Bun.sleep(10);
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await waitForFrameCount(client, before + 1);
    // ...and no second frame for the burst
    await Bun.sleep(150);
    expect(frameCount()).toBe(before + 1);

    // b) a notify after the window -> a fresh frame
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await waitForFrameCount(client, before + 2);
    client.ws.close();
  });

  test("no subprotocol: handshake rejected", async () => {
    const client = connectWs(wsUrl(jobId));
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("invalid token: handshake rejected", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, "not-a-real-token"]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("job outside the user's projects: handshake rejected", async () => {
    const client = connectWs(wsUrl(otherJobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("unknown job: handshake rejected", async () => {
    const client = connectWs(wsUrl(randomUUID()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("ping -> pong", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.send("ping");
    const pong = await waitForMessage<{ type: string }>(client, (m) => m.type === "pong");
    expect(pong).toEqual({ type: "pong" });
    client.ws.close();
  });

  test("hub close() cancels pending debounce timers (no push after close)", async () => {
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    // probe until the lazy LISTEN session is confirmed up
    await notifyUntil(client, jobId, (m) => m?.type === "ota" && m?.job_id === jobId);
    await Bun.sleep(100); // let in-flight debounce pushes settle

    const before = client.messages.filter(isOtaFrame).length;
    // arm a debounce push, then close the hub before the timer fires
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await Bun.sleep(10);
    const hub = await getOtaStreamHub(prisma, process.env.DATABASE_URL ?? "", {
      warn: () => {},
    });
    await hub.close();

    // well past the debounce window: no ota frame may arrive after close
    await Bun.sleep(200);
    expect(client.messages.filter(isOtaFrame).length).toBe(before);
    client.ws.close();
  });
});
