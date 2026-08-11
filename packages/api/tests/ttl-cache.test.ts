/**
 * Tests for the TTL cache used by the WS stream handshake caches
 * (batch/job -> project id). Covers lazy TTL expiry, capacity clearing
 * and normal hit/miss behavior. Uses setSystemTime so no timers are
 * involved.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createTtlCache } from "../src/api/ttl-cache";

const REAL_NOW = Date.now();

beforeEach(() => {
  setSystemTime(new Date(REAL_NOW));
});

afterEach(() => {
  setSystemTime();
});

describe("createTtlCache", () => {
  test("returns stored values within the TTL", () => {
    const cache = createTtlCache<string[]>(10 * 60_000, 1000);
    cache.set("a", ["p1"]);
    cache.set("b", ["p2"]);
    expect(cache.get("a")).toEqual(["p1"]);
    expect(cache.get("b")).toEqual(["p2"]);
  });

  test("expired entries are dropped lazily", () => {
    const cache = createTtlCache<string>(1000, 1000);
    cache.set("a", "p1");
    expect(cache.get("a")).toBe("p1");
    setSystemTime(new Date(REAL_NOW + 1001));
    expect(cache.get("a")).toBeUndefined();
  });

  test("fresh entries survive while older ones expire", () => {
    const cache = createTtlCache<string>(1000, 1000);
    cache.set("a", "p1");
    setSystemTime(new Date(REAL_NOW + 900));
    cache.set("b", "p2"); // b starts its TTL at +900
    setSystemTime(new Date(REAL_NOW + 950));
    expect(cache.get("b")).toBe("p2");
    setSystemTime(new Date(REAL_NOW + 1901));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  test("the whole cache is cleared when the capacity cap is hit", () => {
    const cache = createTtlCache<string>(60_000, 3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBe("1");
    cache.set("d", "4"); // cap reached: clear, then insert d
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("d")).toBe("4");
  });

  test("overwriting a key refreshes its value", () => {
    const cache = createTtlCache<string>(60_000, 100);
    cache.set("a", "old");
    cache.set("a", "new");
    expect(cache.get("a")).toBe("new");
  });
});
