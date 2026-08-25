import { describe, expect, test } from "bun:test";
import { runWithDeadline, runWithOperationLimit } from "../src/server";

describe("plugin runtime deadlines", () => {
  test("passes a signal and resolves work before the deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    await expect(runWithDeadline(100, async (signal) => {
      receivedSignal = signal;
      return "ok";
    })).resolves.toBe("ok");
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("aborts and rejects uncooperative work at the deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    await expect(runWithDeadline(5, (signal) => {
      receivedSignal = signal;
      return new Promise<string>((resolve) => setTimeout(() => resolve("late"), 50));
    })).rejects.toThrow("deadline exceeded");
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("keeps an operation slot until uncooperative work settles", async () => {
    const operations = { running: 0, max: 1 };
    let resolveWork!: () => void;
    let started = false;
    const first = runWithOperationLimit(operations, 5, () => {
      started = true;
      return new Promise<void>((resolve) => { resolveWork = resolve; });
    });

    await expect(first).rejects.toThrow("deadline exceeded");
    expect(started).toBe(true);
    expect(operations.running).toBe(1);
    await expect(runWithOperationLimit(operations, 5, () => "unreachable")).rejects.toThrow("OVERLOADED");

    resolveWork();
    await Bun.sleep(0);
    expect(operations.running).toBe(0);
  });
});
