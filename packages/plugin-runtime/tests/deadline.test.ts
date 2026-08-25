import { describe, expect, test } from "bun:test";
import { runWithDeadline } from "../src/server";

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
});
