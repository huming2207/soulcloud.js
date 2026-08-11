/**
 * AuthSemaphore unit tests (WEB-09): the CPU-bound Argon2id guard must (a)
 * grant slots only when under the concurrency limit, (b) hold queued
 * callers until a slot frees (they must not start hashing early), and
 * (c) refuse instead of growing unbounded when the queue saturates.
 */
import { describe, expect, test } from "bun:test";
import { AuthSemaphore } from "../src/mqtt/broker";

describe("AuthSemaphore", () => {
  test("grants at most `limit` slots immediately; queues the rest", async () => {
    const sem = new AuthSemaphore(2, 100);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    // queued callers must NOT be granted while both slots are held
    let granted = false;
    const queued = sem.acquire().then((r) => {
      granted = true;
      return r;
    });
    await Bun.sleep(20);
    expect(granted).toBe(false);

    // freeing one slot grants exactly one queued caller
    r1!();
    const q1 = await Promise.race([
      queued,
      Bun.sleep(50).then(() => "timeout" as const),
    ]);
    expect(q1).not.toBe("timeout");
    // the other queued caller is still waiting (slot taken by q1)
    let granted2 = false;
    const queued2 = sem.acquire().then((r) => {
      granted2 = true;
      return r;
    });
    await Bun.sleep(20);
    expect(granted2).toBe(false);
    r2!();
    const q2 = await Promise.race([
      queued2,
      Bun.sleep(50).then(() => "timeout" as const),
    ]);
    expect(q2).not.toBe("timeout");
    // release the two granted slots to drain the queue
    (q1 as () => void)();
    (q2 as () => void)();
  });

  test("refuses (null) when the queue is saturated", async () => {
    const sem = new AuthSemaphore(1, 2);
    const slot = await sem.acquire(); // immediate slot
    const q1 = sem.acquire(); // queued (not awaited yet)
    const q2 = sem.acquire(); // queued
    expect(await sem.acquire()).toBeNull(); // queue full -> refuse now
    // drain the queue so no promises stay pending
    slot!();
    (await q1)!();
    (await q2)!();
  });

  test("grants queued slots FIFO on release", async () => {
    const sem = new AuthSemaphore(1, 10);
    const r1 = await sem.acquire();
    const order: string[] = [];
    const p2 = sem.acquire().then((r) => {
      order.push("second");
      return r;
    });
    const p3 = sem.acquire().then((r) => {
      order.push("third");
      return r;
    });
    r1!(); // free the slot -> second granted
    await Bun.sleep(10);
    expect(order).toEqual(["second"]);
    const r2 = await p2;
    r2!(); // free -> third granted
    await Bun.sleep(10);
    expect(order).toEqual(["second", "third"]);
    (await p3)!();
  });
});
