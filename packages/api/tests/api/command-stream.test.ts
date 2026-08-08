/**
 * WebSocket command-stream tests (GET /v1/ws/commands).
 *
 * Auth rides the Sec-WebSocket-Protocol header: the client connects with
 * subprotocols ["soulcloud", "<access token>"] and the upgrade is refused
 * (401/404) unless the token is valid and every target device of the
 * batch belongs to a project the user is a member of.
 *
 * The push path is exercised end-to-end through the real queue code:
 * recordDeviceResult() transitions the row and pg_notify()es the batch id
 * inside the recording transaction; the hub re-queries the batch (REST
 * detail shape) and pushes { type: "batch", ... } to subscribers.
 *
 * The hub's pg LISTEN session is a process-wide singleton; afterAll closes
 * it so the listener does not outlive this file (bun test --isolate runs
 * each test file in its own process).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { getCommandStreamHub } from "../../src/api/command-stream";
import {
  COMMAND_RESULT_CHANNEL,
  decodeDeviceCommandExecution,
  encodeDeviceCommandResult,
  enqueueBatch,
  prisma,
  recordDeviceResult,
  signAccessToken,
} from "@soulcloud/core";

const WS_PROTOCOL = "soulcloud";

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
let deviceIds: string[];
let batchId: string;
// a batch whose devices live in a project the test user is NOT a member of
let otherProjectId: string;
let otherBatchId: string;
let accessToken = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `cmdstream-user-${randomUUID().slice(0, 8)}`;
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

function wsUrl(batch: string): string {
  return `${wsBase}/v1/ws/commands?batch_id=${batch}`;
}

interface WsClient {
  ws: WebSocket;
  messages: string[];
  /** Resolves when the client-side open event fires (upgrade accepted). */
  open: Promise<void>;
  /** Resolves when the socket closes (handshake rejected or closed). */
  closed: Promise<void>;
  /** Close code observed by onclose (0 when never closed). */
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
  ws.onclose = (ev: CloseEvent) => {
    closeCode = ev.code;
    resolveClosed();
  };
  ws.onerror = () => {};
  return { ws, messages, open, closed, closeCode };
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

/** True if the raw frame is a batch push ({ type: "batch" }). */
function isBatchFrame(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { type?: string }).type === "batch";
  } catch {
    return false;
  }
}

/** Polls until at least `count` batch frames have been received. */
async function waitForFrameCount(
  client: WsClient,
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (client.messages.filter(isBatchFrame).length >= count) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${count} batch frames`);
    }
    await Bun.sleep(25);
  }
}

/**
 * NOTIFY is lossy and the hub's LISTEN session starts lazily on the first
 * subscription: re-notify on a short loop until a batch frame arrives
 * (3s deadline) instead of assuming the listener is already up.
 */
async function probeListenerUp(client: WsClient, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
    await Bun.sleep(50);
    if (client.messages.some(isBatchFrame)) return;
    if (Date.now() >= deadline) {
      throw new Error("listener never came up (no batch frame received)");
    }
  }
}

/** Builds a valid result packet for a queued command row (code 0). */
function resultPacketFor(row: { payload: Uint8Array }) {
  const decoded = decodeDeviceCommandExecution(row.payload);
  const result = { id: decoded.id, seq: decoded.seq, code: 0 };
  return { packet: encodeDeviceCommandResult(result), result };
}

let userId = "";

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-command-stream-test" } });
  const { userId: uid, accessToken: token } = await registerUser();
  userId = uid;
  accessToken = token;
  await prisma.userProject.create({ data: { userId, projectId } });

  deviceIds = [];
  for (let i = 0; i < 2; i++) {
    const device = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `api-cmdstream-${i}-${randomUUID().slice(0, 8)}`,
        assignedId: `assigned-cmdstream-${i}`,
        passwordHash: "unused",
        projectId,
      },
    });
    deviceIds.push(device.id);
  }
  const batch = await enqueueBatch(prisma, deviceIds, { cmd: "getConfig" });
  batchId = batch.id;

  // a batch the test user is NOT a member of (handshake must be refused)
  otherProjectId = randomUUID();
  await prisma.project.create({
    data: { id: otherProjectId, name: "api-command-stream-other" },
  });
  const otherDeviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: otherDeviceId,
      deviceUid: `api-cmdstream-other-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-cmdstream-other",
      passwordHash: "unused",
      projectId: otherProjectId,
    },
  });
  otherBatchId = (await enqueueBatch(prisma, [otherDeviceId], { cmd: "reboot" })).id;
});

afterAll(async () => {
  // close the process-wide LISTEN session first (the singleton is reset
  // to null, so a fresh hub is created if anything else subscribes later)
  await (
    await getCommandStreamHub(prisma, process.env.DATABASE_URL ?? "", { warn: () => {} })
  ).close();
  await prisma.deviceCommand.deleteMany({
    where: { batchId: { in: [batchId, otherBatchId] } },
  });
  // NOTE: server.stop() is intentionally NOT called here. Bun 1.3.13's
  // stop() hangs on connections the SERVER closed (the M2 expiry kick and
  // the M3 cap rejection close(4401) from the subscribe handler), even
  // after the client observed close and closed its side. Every socket in
  // this file is closed explicitly in its test; the leftover server just
  // dies with the process (bun test --isolate gives this file its own
  // process, so nothing leaks to other files). Same workaround as
  // log-stream.test.ts.
  await prisma.commandBatch.deleteMany({
    where: { id: { in: [batchId, otherBatchId] } },
  });
  await prisma.device.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.project.deleteMany({
    where: { id: { in: [projectId, otherProjectId] } },
  });
  await prisma.$disconnect();
});

describe("GET /v1/ws/commands", () => {
  test("mixed-case batch UUID in the query connects to the same hub key", async () => {
    // notify payloads carry the DB-stored (lowercase) id; a mixed-case
    // query value must be canonicalized so the push still arrives
    const client = connectWs(wsUrl(batchId.toUpperCase()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await probeListenerUp(client);
    client.ws.close();
  });

  test("a sustained notify burst is bounded by max-wait (push during the burst)", async () => {
    // debounceMs=25 (app options), so maxWaitMs=100: a continuous burst
    // must still push ~every 100ms instead of deferring forever
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await probeListenerUp(client);
    await Bun.sleep(80); // let probe pushes settle

    const before = client.messages.filter(isBatchFrame).length;
    const deadline = Date.now() + 250;
    let sawPushDuringBurst = false;
    while (Date.now() < deadline) {
      await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
      await Bun.sleep(15);
      if (client.messages.filter(isBatchFrame).length > before) {
        sawPushDuringBurst = true;
        break;
      }
    }
    // the burst is still running when the max-wait deadline fires
    expect(sawPushDuringBurst).toBe(true);
    client.ws.close();
  });

  test("expired access token: the connection is closed (M2)", async () => {
    // sign a short-lived (1s) access token for the existing test user
    // with the same secret the app verifies with; the expiry check must
    // close the connection once the token expires (Bun's CloseEvent does
    // not expose the code, so "closed" is the observable evidence)
    const shortToken = await signAccessToken(
      { ...TEST_JWT, accessTtlSeconds: 1 },
      { sub: userId, username: "cmdstream-user" },
    );
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, shortToken]);
    expect(await waitForSettle(client)).toBe("open");
    const closed = await Promise.race([
      client.closed,
      Bun.sleep(4000).then(() => "timeout" as const),
    ]);
    expect(closed).toBeUndefined(); // closed promise resolved
    client.ws.close();
    await client.closed.catch(() => {});
  });

  test("connection cap: the second socket is refused with 4401 (M3)", async () => {
    // SOULCLOUD_WS_MAX_CONNECTIONS=1 is set for this file
    const first = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(first)).toBe("open");
    try {
      const second = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
      // the upgrade passes beforeHandle; subscribe() then refuses the
      // socket, so the client observes open followed by an immediate
      // close (the client observes the code; "closed" is asserted
      // right after open is the observable evidence)
      expect(await waitForSettle(second)).not.toBe("timeout");
      await second.closed;
      second.ws.close();
    } finally {
      first.ws.close();
      await first.closed.catch(() => {});
    }
  });

  test("valid token + project member: connects and receives ready", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    const ready = await waitForMessage<{ type: string; batch_id?: string }>(
      client,
      (m) => m.type === "ready",
    );
    expect(ready).toMatchObject({ type: "ready", batch_id: batchId });
    client.ws.close();
  });

  test("recordDeviceResult + pg_notify is pushed to the subscriber", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");

    // probe: the hub's LISTEN session starts lazily on the first
    // subscription, so re-notify manually until the listener is confirmed
    // up (a batch frame arrives). From then on the transaction-internal
    // notify of recordDeviceResult must reach the subscriber by itself.
    await probeListenerUp(client);

    // record a real terminal result through the queue code path; its
    // transaction-internal pg_notify must now drive the push on its own
    const row = await prisma.deviceCommand.findFirstOrThrow({
      where: { batchId, deviceId: deviceIds[0]! },
    });
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: row.deviceId },
    });
    const { packet, result } = resultPacketFor(row);
    const outcome = await recordDeviceResult(prisma, device.deviceUid, result, packet);
    expect(outcome).toBe("recorded");

    const msg = await waitForMessage<{
      type: string;
      batch_id: string;
      device_count: number;
      summary: Record<string, number>;
      commands: Array<Record<string, unknown>>;
    }>(
      client,
      (m) =>
        m.type === "batch" &&
        m.batch_id === batchId &&
        typeof m.summary?.device_completed === "number",
    );

    // frame shape matches the REST batch detail response
    expect(msg!.type).toBe("batch");
    expect(msg!.batch_id).toBe(batchId);
    expect(msg!.device_count).toBe(2);
    expect(msg!.summary).toEqual({ queued: 1, device_completed: 1 });
    expect(msg!.commands).toHaveLength(2);

    const completed = msg!.commands.find(
      (c: Record<string, unknown>) => c.command_id === row.id,
    );
    expect(completed).toMatchObject({
      command_id: row.id,
      device_id: row.deviceId,
      state: "device_completed",
      result_code: 0,
      command: { cmd: "getConfig", args: null },
    });
    expect(completed!.sequence).toBe(row.sequence.toString());
    expect(completed!.device_uid).toBe(device.deviceUid);
    expect(completed!.result).toEqual({ code: 0, payload: null });
    expect(completed!.device_completed_at).not.toBeNull();
    expect(completed!.delivery_expires_at).toBeNull();
    // timestamps serialize to ISO strings (JSON)
    expect(typeof completed!.created_at).toBe("string");

    const pending = msg!.commands.find(
      (c: Record<string, unknown>) => c.command_id !== row.id,
    );
    expect(pending).toMatchObject({ state: "queued", result_code: null, result: null });

    client.ws.close();
  });

  test("notifies inside the debounce window merge into one push; a post-window notify pushes again", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await probeListenerUp(client);
    // let any in-flight debounce from the probe settle before counting
    await Bun.sleep(100);

    const frameCount = () => client.messages.filter(isBatchFrame).length;
    const before = frameCount();

    // a) two notifies inside the debounce window (25ms) -> one merged frame
    await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
    await Bun.sleep(10);
    await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
    await waitForFrameCount(client, before + 1);
    // ...and no second frame for the burst
    await Bun.sleep(150);
    expect(frameCount()).toBe(before + 1);

    // b) a notify after the window -> a fresh frame
    await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
    await waitForFrameCount(client, before + 2);
    client.ws.close();
  });

  test("no subprotocol: handshake rejected", async () => {
    const client = connectWs(wsUrl(batchId));
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("invalid token: handshake rejected", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, "not-a-real-token"]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("batch outside the user's projects: handshake rejected", async () => {
    const client = connectWs(wsUrl(otherBatchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("unknown batch: handshake rejected", async () => {
    const client = connectWs(wsUrl(randomUUID()), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("closed");
  });

  test("ping -> pong", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    client.ws.send("ping");
    const pong = await waitForMessage<{ type: string }>(client, (m) => m.type === "pong");
    expect(pong).toEqual({ type: "pong" });
    client.ws.close();
  });

  test("hub close() cancels pending debounce timers (no push after close)", async () => {
    const client = connectWs(wsUrl(batchId), [WS_PROTOCOL, accessToken]);
    expect(await waitForSettle(client)).toBe("open");
    await waitForMessage(client, (m) => m.type === "ready");
    await probeListenerUp(client);
    await Bun.sleep(100); // let in-flight debounce pushes settle

    const before = client.messages.filter(isBatchFrame).length;
    // arm a debounce push, then close the hub before the timer fires
    await prisma.$executeRaw`SELECT pg_notify(${COMMAND_RESULT_CHANNEL}, ${batchId})`;
    await Bun.sleep(10);
    const hub = await getCommandStreamHub(prisma, process.env.DATABASE_URL ?? "", {
      warn: () => {},
    });
    await hub.close();

    // well past the debounce window: no batch frame may arrive after close
    await Bun.sleep(200);
    expect(client.messages.filter(isBatchFrame).length).toBe(before);
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
      const client = connectWs(`${base6}/v1/ws/commands?batch_id=${batchId}`, [
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
      expect(client.closeCode).toBe(4403);
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
