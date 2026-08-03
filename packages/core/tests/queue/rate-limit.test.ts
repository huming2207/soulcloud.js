import { describe, expect, test } from "bun:test";
import { PerDeviceLimiter, TokenBucket } from "../../src/queue/rate-limit";

describe("TokenBucket", () => {
  test("allows up to capacity immediately", () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect(bucket.tryConsume(1, 0)).toBe(true);
    expect(bucket.tryConsume(2, 0)).toBe(true);
    expect(bucket.tryConsume(1, 0)).toBe(false); // empty
  });

  test("refills over time", () => {
    const bucket = new TokenBucket(3, 2, 0); // 2 tokens/second
    expect(bucket.tryConsume(3, 0)).toBe(true);
    expect(bucket.tryConsume(1, 500)).toBe(true); // +1 token after 500ms
    expect(bucket.tryConsume(1, 500)).toBe(false); // consumed the refill
  });

  test("caps at capacity", () => {
    const bucket = new TokenBucket(2, 10, 0);
    expect(bucket.tryConsume(1, 0)).toBe(true);
    // long idle: refill must not exceed capacity
    expect(bucket.tryConsume(2, 100_000)).toBe(true);
    expect(bucket.tryConsume(1, 100_000)).toBe(false);
  });
});

describe("PerDeviceLimiter", () => {
  test("limits per device independently", () => {
    const limiter = new PerDeviceLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(limiter.tryConsume("dev-a", 1, 0)).toBe(true);
    expect(limiter.tryConsume("dev-a", 1, 0)).toBe(true);
    expect(limiter.tryConsume("dev-a", 1, 0)).toBe(false); // dev-a exhausted
    expect(limiter.tryConsume("dev-b", 1, 0)).toBe(true); // dev-b unaffected
    expect(limiter.size).toBe(2);
  });

  test("fails closed when the device table saturates", () => {
    const limiter = new PerDeviceLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxDevices: 2,
    });
    expect(limiter.tryConsume("a", 1, 0)).toBe(true);
    expect(limiter.tryConsume("b", 1, 0)).toBe(true);
    // third device while saturated: dropped (fail closed)
    expect(limiter.tryConsume("c", 1, 0)).toBe(false);
  });

  test("reclaims idle buckets", () => {
    const limiter = new PerDeviceLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxDevices: 1,
      idleTimeoutMs: 100,
    });
    expect(limiter.tryConsume("a", 1, 0)).toBe(true);
    expect(limiter.tryConsume("b", 1, 0)).toBe(false); // saturated
    // after idle timeout, "a" is reclaimed on the next try
    expect(limiter.tryConsume("b", 1, 200)).toBe(true);
    expect(limiter.size).toBe(1);
  });
});
