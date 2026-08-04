import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { COMMAND_NOTIFY_CHANNEL, enqueueBatch, prisma } from "@soulcloud/core";
import { startCommandNotifier } from "../../src/mqtt/notify";

// Integration test for the LISTEN/NOTIFY wake-up.
// Requires: docker compose up -d postgres && bunx prisma migrate deploy

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

let projectId: string;
let deviceId: string;
let notifierClose: () => Promise<void>;

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "notify-test-project" },
  });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: `notify-test-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-notify",
      passwordHash: "unused-hash",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM command_batches`;
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("command notifier", () => {
  test("receives a notification published by another connection", async () => {
    const wakeups: string[] = [];
    const notifier = await startCommandNotifier(
      process.env.DATABASE_URL!,
      () => wakeups.push("wake"),
      silentLog,
    );
    notifierClose = notifier.close;

    // publish from a separate connection
    const publisher = new Client({ connectionString: process.env.DATABASE_URL });
    await publisher.connect();
    await publisher.query(
      `SELECT pg_notify($1, 'manual-test')`,
      [COMMAND_NOTIFY_CHANNEL],
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("notification timeout")), 3000);
      const check = setInterval(() => {
        if (wakeups.length > 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(wakeups.length).toBeGreaterThan(0);
    await publisher.end();
    await notifier.close();
  });

  test("enqueueBatch wakes the notifier after commit", async () => {
    const wakeups: string[] = [];
    const notifier = await startCommandNotifier(
      process.env.DATABASE_URL!,
      () => wakeups.push("wake"),
      silentLog,
    );
    notifierClose = notifier.close;

    // wait until LISTEN is active before enqueueing
    await new Promise((r) => setTimeout(r, 100));

    await enqueueBatch(prisma, [deviceId], { cmd: "reboot" });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("enqueue notification timeout")), 3000);
      const check = setInterval(() => {
        if (wakeups.length > 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(wakeups.length).toBeGreaterThan(0);
    await notifier.close();
  });
});

describe("M9: notifier reconnection", () => {
  test("recovers after the connection is killed", async () => {
    const wakeups: string[] = [];
    const notifier = await startCommandNotifier(
      process.env.DATABASE_URL!,
      () => wakeups.push("wake"),
      silentLog,
    );
    await new Promise((r) => setTimeout(r, 100));

    // kill every connection to the notifier's session by terminating all
    // pg connections from this app (the dedicated LISTEN connection drops)
    await prisma.$executeRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pg' AND pid <> pg_backend_pid()`;

    // wait for the reconnect (1s delay) then publish again
    await new Promise((r) => setTimeout(r, 1500));
    const before = wakeups.length;
    const publisher = new Client({ connectionString: process.env.DATABASE_URL });
    await publisher.connect();
    await publisher.query(`SELECT pg_notify($1, 'after-reconnect')`, [COMMAND_NOTIFY_CHANNEL]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no wake after reconnect")), 4000);
      const check = setInterval(() => {
        if (wakeups.length > before) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(wakeups.length).toBeGreaterThan(before);
    await publisher.end();
    await notifier.close();
  });
});
