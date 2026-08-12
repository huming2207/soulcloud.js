import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { PrismaClient } from "@soulcloud/core";
import { scheduleMembershipCheck } from "../../src/api/ws-access";

describe("scheduleMembershipCheck", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const stop of cleanups.splice(0)) stop();
  });

  test("does not overlap a slow membership query", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const first = new Promise<Array<{ projectId: string }>>((resolve) => {
      releaseFirst = () => resolve([{ projectId: "project-a" }]);
    });
    const findMany = mock(() => {
      calls += 1;
      return calls === 1 ? first : Promise.resolve([{ projectId: "project-a" }]);
    });
    const prisma = {
      userProject: { findMany },
    } as unknown as PrismaClient;
    const socket = {
      readyState: 1,
      close: mock(() => {}),
    } as unknown as ServerWebSocket;

    const stop = scheduleMembershipCheck(socket, prisma, "user-a", ["project-a"], 5);
    cleanups.push(stop);

    await Bun.sleep(25);
    expect(calls).toBe(1);

    releaseFirst();
    await Bun.sleep(15);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("closes revoked access after the batched check", async () => {
    const close = mock(() => {});
    const prisma = {
      userProject: { findMany: mock(() => Promise.resolve([{ projectId: "project-a" }])) },
    } as unknown as PrismaClient;
    const socket = {
      readyState: 1,
      close,
    } as unknown as ServerWebSocket;

    const stop = scheduleMembershipCheck(socket, prisma, "user-a", ["project-a", "project-b"], 5);
    cleanups.push(stop);

    await Bun.sleep(20);
    expect(close).toHaveBeenCalledWith(4403, "access revoked");
  });
});
