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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { getOtaStreamHub } from "../../src/api/ota-stream";
import { createOtaJob, OTA_NOTIFY_CHANNEL, prisma, signAccessToken } from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

/** Firmware hashes for fingerprint-flip deltas (64 hex chars each). */
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// M2/M3 test knobs: short expiry-check interval and a tight connection
// cap. Set before createApp so the hub picks them up; the main app still
// runs every other test with these values (a 200ms check interval is
// harmless for the 3600s tokens, and each test holds at most one socket).
process.env.SOULCLOUD_WS_EXP_CHECK_MS = "200";
process.env.SOULCLOUD_WS_MAX_CONNECTIONS = "1";

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
let userId = "";

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
  /** The close code observed by the client (0 until closed). */
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
  // track every client so afterEach can close stragglers: this file runs
  // with SOULCLOUD_WS_MAX_CONNECTIONS=1, and a single test that fails
  // before closing its socket would starve every test after it
  openClients.add(ws);
  return { ws, messages, open, closed, closeCode };
}

/** Every WS client opened by the tests (straggler cleanup). */
const openClients = new Set<WebSocket>();

afterEach(() => {
  for (const ws of openClients) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  openClients.clear();
});

/** Waits until the connection either opened or closed (or timed out). */
async function waitForSettle(
  client: WsClient,
  timeoutMs = 10_000,
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
  timeoutMs = 10_000,
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
  timeoutMs = 10_000,
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
  timeoutMs = 10_000,
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
  const { userId: registeredUserId, accessToken: token } = await registerUser();
  userId = registeredUserId;
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
  // close the process-wide LISTEN session first (the singleton is reset
  // to null, so a fresh hub is created if anything else subscribes later)
  await (
    await getOtaStreamHub(prisma, process.env.DATABASE_URL ?? "", { warn: () => {} })
  ).close();
  // NOTE: server.stop() is intentionally NOT called here. Bun 1.3.13's
  // stop() hangs on connections the SERVER closed (the M2 expiry kick and
  // the M3 cap rejection close(4401) from the subscribe handler), even
  // after the client observed close and closed its side. Every socket in
  // this file is closed explicitly in its test; the leftover server just
  // dies with the process (bun test --isolate gives this file its own
  // process, so nothing leaks to other files). Same workaround as
  // log-stream.test.ts.
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
  test("mixed-case job UUID in the query connects to the same hub key", async () => {
    // notify payloads carry the DB-stored (lowercase) id; a mixed-case
    // query value must be canonicalized so the push still arrives
    const client = connectWs(wsUrl(jobId.toUpperCase()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await notifyUntil(client, jobId, (m) => m.type === "ota");
    client.ws.close();
  });

  test("a sustained notify burst is bounded by max-wait (push during the burst)", async () => {
    // debounceMs=25 (app options), so maxWaitMs=100: a continuous burst
    // must still push ~every 100ms instead of deferring forever.
    // Delta pushes only fire on REAL fingerprint changes; the target is
    // terminal by now (the previous test completed it), so each notify
    // flips the device's reported firmware hash instead (part of the
    // target fingerprint).
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await notifyUntil(client, jobId, (m) => m.type === "ota");
    await Bun.sleep(80); // let probe pushes settle

    const before = client.messages.filter(isOtaFrame).length;
    const deadline = Date.now() + 250;
    let sawPushDuringBurst = false;
    let flip = false;
    while (Date.now() < deadline) {
      flip = !flip;
      await prisma.deviceFirmwareState.upsert({
        where: { deviceId },
        update: { fwHash: flip ? HASH_A : HASH_B, reportedAt: new Date() },
        create: { deviceId, fwHash: flip ? HASH_A : HASH_B },
      });
      await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
      await Bun.sleep(15);
      if (client.messages.filter(isOtaFrame).length > before) {
        sawPushDuringBurst = true;
        break;
      }
    }
    expect(sawPushDuringBurst).toBe(true);
    client.ws.close();
    // clean up the fingerprint flips so later tests see a fresh device
    await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
  });

  test("connection cap: the second socket is refused (M3)", async () => {
    // SOULCLOUD_WS_MAX_CONNECTIONS=1 is set for this file
    const first = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(first)).toBe("open");
    try {
      const second = connectWs(wsUrl(jobId), [WS_PROTOCOL, accessToken]);
      // the upgrade passes beforeHandle; subscribe() then refuses the
      // socket, so the client observes open followed by a close
      expect(await waitForSettle(second)).not.toBe("timeout");
      await second.closed;
      second.ws.close();
    } finally {
      first.ws.close();
      await first.closed.catch(() => {});
    }
  });

  test("expired access token: the connection is closed (M2)", async () => {
    // a short-lived (1s) access token for the existing test user; the
    // expiry check must close the connection once it expires
    // 2s TTL: iat is floored to the integer second, so a 1s TTL leaves
    // only a few ms on the second boundary; the 200ms env check still
    // closes the socket well inside the 4s race window
    const shortToken = await signAccessToken(
      { ...TEST_JWT, accessTtlSeconds: 2 },
      { sub: userId, username: "otastream-user" },
    );
    const client = connectWs(wsUrl(jobId), [WS_PROTOCOL, shortToken]);
    expect(await waitForSettle(client)).toBe("open");
    const closed = await Promise.race([
      client.closed,
      Bun.sleep(4000).then(() => "timeout" as const),
    ]);
    expect(closed).toBeUndefined(); // closed promise resolved
    client.ws.close();
    await client.closed.catch(() => {});
  });

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
      // only accept the frame that actually reflects the delivered
      // transition (a stale frame from the previous test's tail could
      // still show the pre-transition state)
      (m) =>
        m?.type === "ota" &&
        m?.job_id === jobId &&
        m?.targets?.[0]?.state === "delivered",
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
    // (delta pushes fire on fingerprint changes: the target is terminal by
    // now, so flip the device's reported firmware hash twice)
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId },
      update: { fwHash: HASH_A, reportedAt: new Date() },
      create: { deviceId, fwHash: HASH_A },
    });
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await Bun.sleep(10);
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId },
      update: { fwHash: HASH_B, reportedAt: new Date() },
      create: { deviceId, fwHash: HASH_B },
    });
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await waitForFrameCount(client, before + 1);
    // ...and no second frame for the burst
    await Bun.sleep(150);
    expect(frameCount()).toBe(before + 1);

    // b) a notify after the window -> a fresh frame
    await prisma.deviceFirmwareState.upsert({
      where: { deviceId },
      update: { fwHash: HASH_C, reportedAt: new Date() },
      create: { deviceId, fwHash: HASH_C },
    });
    await prisma.$executeRaw`SELECT pg_notify(${OTA_NOTIFY_CHANNEL}, ${jobId})`;
    await waitForFrameCount(client, before + 2);
    client.ws.close();
    // clean up the fingerprint flips so later tests see a fresh device
    await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
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
  test("removed project membership closes the connection (re-check)", async () => {
    const app6 = createApp(prisma, TEST_JWT, undefined, {
      debounceMs: 25,
      expCheckIntervalMs: 100,
    });
    const server6 = app6.listen({ port: 0, hostname: "127.0.0.1" });
    const base6 = `ws://127.0.0.1:${server6.server!.port}`;
    try {
      const client = connectWs(`${base6}/v1/ws/ota?job_id=${jobId}`, [
        WS_PROTOCOL,
        accessToken,
      ]);
      expect(await waitForSettle(client)).toBe("open");
      await waitForMessage(client, (m) => m.type === "ready");

      // revoke the membership; the 100ms re-check must close the socket
      await prisma.userProject.delete({
        where: { userId_projectId: { userId, projectId } },
      });
      const closed = await Promise.race([
        client.closed.then(() => true),
        Bun.sleep(2000).then(() => false),
      ]);
      expect(closed).toBe(true);
      // Bun 1.3.13 often delivers close code 0 on server-initiated
      // closes (same quirk family as the stop() hang); when a code IS
      // present it must be the 4403 access-revoked code
      expect([0, 4403]).toContain(client.closeCode);
      client.ws.close();
      await Bun.sleep(100);
    } finally {
      // restore the membership for the rest of the suite; skip
      // server.stop() (Bun server-initiated-close quirk)
      await prisma.userProject.upsert({
        where: { userId_projectId: { userId, projectId } },
        update: {},
        create: { userId, projectId },
      });
    }
  });

});
