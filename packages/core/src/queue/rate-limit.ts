/**
 * Simple token-bucket rate limiter for per-device uplink ingestion.
 *
 * Protects the log ingestion path from DDoS / misbehaving devices: a device
 * can send at most `rate` tokens per second with a burst allowance of
 * `capacity`. Excess traffic is dropped (counted, never buffered).
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  /** Tries to consume `n` tokens; returns false when the bucket is empty. */
  tryConsume(n: number, now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed / 1000) * this.refillPerSecond,
    );
    this.lastRefill = now;
  }
}

export interface PerDeviceLimiterOptions {
  /** Token bucket capacity (max burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Idle time (ms) after which a device bucket is forgotten. */
  idleTimeoutMs?: number;
  /** Max tracked devices (guards against unbounded memory from many UIDs). */
  maxDevices?: number;
}

/**
 * Per-device token buckets with automatic reclamation of idle buckets.
 */
export class PerDeviceLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly lastSeen = new Map<string, number>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly idleTimeoutMs: number;
  private readonly maxDevices: number;

  constructor(options: PerDeviceLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.maxDevices = options.maxDevices ?? 10_000;
  }

  /**
   * Tries to consume `tokens` for a device.
   *
   * @returns false when the device is over its limit (caller should drop).
   */
  tryConsume(deviceId: string, tokens = 1, now = Date.now()): boolean {
    this.reclaim(now);
    let bucket = this.buckets.get(deviceId);
    if (!bucket) {
      if (this.buckets.size >= this.maxDevices) {
        return false; // limiter is saturated; fail closed
      }
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, now);
      this.buckets.set(deviceId, bucket);
    }
    this.lastSeen.set(deviceId, now);
    return bucket.tryConsume(tokens, now);
  }

  private lastReclaim = 0;

  /** Drops buckets that have been idle for `idleTimeoutMs`.
   *
   * Only runs when the table is at capacity and at most once per second
   * (M7: a full scan per packet would be an O(n) amplification under a
   * random-device-ID flood). */
  private reclaim(now: number): void {
    if (this.buckets.size < this.maxDevices) return;
    if (now - this.lastReclaim < 1000) return;
    this.lastReclaim = now;
    for (const [id, seenAt] of this.lastSeen) {
      if (now - seenAt > this.idleTimeoutMs) {
        this.buckets.delete(id);
        this.lastSeen.delete(id);
      }
    }
  }

  /** Number of tracked devices (for tests/diagnostics). */
  get size(): number {
    return this.buckets.size;
  }
}
