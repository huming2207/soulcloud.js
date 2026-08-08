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
} from "@soulcloud/core";

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

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "api-command-stream-test" } });
  const { userId, accessToken: token } = await registerUser();
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
  // stop(true): Bun's server.stop() defaults to waiting for active
  // connections, which would hang on lingering WebSockets
  await server.stop(true);
  // close the process-wide LISTEN session (the singleton is reset to null,
  // so a fresh hub is created if anything else subscribes later)
  await (
    await getCommandStreamHub(prisma, process.env.DATABASE_URL ?? "", { warn: () => {} })
  ).close();
  await prisma.deviceCommand.deleteMany({
    where: { batchId: { in: [batchId, otherBatchId] } },
  });
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
});
