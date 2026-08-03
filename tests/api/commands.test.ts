import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import { createApp } from "../../src/api/app";
import type { PrismaClient } from "../../generated/prisma/client";

// API integration tests against the local development PostgreSQL.
// Requires: docker compose up -d postgres && bunx prisma migrate deploy

const app = createApp(prisma);

let projectId: string;
const deviceIds: string[] = [];

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "api-test-project" },
  });
  for (let i = 0; i < 2; i++) {
    const device = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `api-test-${i}-${randomUUID().slice(0, 8)}`,
        assignedId: `assigned-${i}`,
        passwordHash: "unused-hash",
        projectId,
      },
    });
    deviceIds.push(device.id);
  }
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`;
});

async function postBatch(body: unknown): Promise<Response> {
  return app.handle(
    new Request("http://localhost/v1/command-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("health endpoints", () => {
  test("GET /health/live returns ok", async () => {
    const res = await app.handle(new Request("http://localhost/health/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready returns ready", async () => {
    const res = await app.handle(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });
});

describe("POST /v1/command-batches", () => {
  test("creates a batch and returns 202", async () => {
    const res = await postBatch({
      device_ids: deviceIds,
      command: { cmd: "setLogging", args: [{ enabled: true }] },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { batch_id: string; device_count: number };
    expect(body.device_count).toBe(2);

    const rows = await prisma.deviceCommand.findMany({
      where: { batchId: body.batch_id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "queued")).toBe(true);
  });

  test("empty device_ids -> 400 invalid_targets", async () => {
    const res = await postBatch({ device_ids: [], command: { cmd: "reboot" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_targets" });
  });

  test("duplicate device_ids -> 400 invalid_targets", async () => {
    const res = await postBatch({
      device_ids: [deviceIds[0]!, deviceIds[0]!],
      command: { cmd: "reboot" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_targets" });
  });

  test("unknown device -> 404 target_devices_not_found", async () => {
    const res = await postBatch({
      device_ids: [randomUUID()],
      command: { cmd: "reboot" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "target_devices_not_found",
    });
  });

  test("unsafe device UID -> 422 invalid_device_uid", async () => {
    const badDevice = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: "bad/uid",
        assignedId: "assigned-bad",
        passwordHash: "unused-hash",
        projectId,
      },
    });
    const res = await postBatch({
      device_ids: [badDevice.id],
      command: { cmd: "reboot" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_device_uid" });
  });

  test("malformed body -> 400 invalid_request", async () => {
    const res = await postBatch({ device_ids: ["not-a-uuid"], command: { cmd: "reboot" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("missing cmd -> 400 invalid_request", async () => {
    const res = await postBatch({ device_ids: deviceIds, command: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("unknown command field -> 400 invalid_request", async () => {
    const res = await postBatch({
      device_ids: deviceIds,
      command: { cmd: "reboot", extra: 1 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("database failure -> 500 command_queue_unavailable", async () => {
    const brokenPrisma = {
      $transaction: () => Promise.reject(new Error("boom")),
    } as unknown as PrismaClient;
    const brokenApp = createApp(brokenPrisma);
    const res = await brokenApp.handle(
      new Request("http://localhost/v1/command-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_ids: deviceIds, command: { cmd: "reboot" } }),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("command_queue_unavailable");
    // internal details must not leak
    expect(body.message).not.toContain("boom");
  });
});
