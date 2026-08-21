/**
 * Unit tests for the installation circuit breaker (dispatcher.ts).
 *
 * The H1 regression: the old half-open implementation consumed a
 * "trial slot" as a side effect of evaluating `open`. An idle tick with an
 * empty queue burned the slot, and the installation stalled forever once
 * new work arrived. These tests pin the timestamp-based semantics: `open`
 * is pure, cooldown expiry alone re-admits traffic.
 */

import { describe, expect, test } from "bun:test";
import { InstallationCircuitBreaker } from "../src/dispatcher";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("InstallationCircuitBreaker", () => {
  test("stays closed below the consecutive-failure threshold", () => {
    const clock = fakeClock();
    const breaker = new InstallationCircuitBreaker(3, 1_000, clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.open).toBe(false);
  });

  test("opens at the threshold and blocks for the whole cooldown", () => {
    const clock = fakeClock();
    const breaker = new InstallationCircuitBreaker(3, 1_000, clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.open).toBe(true);
    clock.advance(999);
    expect(breaker.open).toBe(true);
  });

  test("re-admits traffic after the cooldown even when nothing was dispatched", () => {
    const clock = fakeClock();
    const breaker = new InstallationCircuitBreaker(2, 1_000, clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.open).toBe(true);
    clock.advance(1_000);
    // Idle scheduler ticks evaluate `open` repeatedly while the queue is
    // empty; none of them may consume a trial slot (H1 regression).
    for (let i = 0; i < 10; i += 1) {
      expect(breaker.open).toBe(false);
    }
  });

  test("re-opens when failures continue after the cooldown", () => {
    const clock = fakeClock();
    const breaker = new InstallationCircuitBreaker(2, 1_000, clock.now);
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(1_000);
    expect(breaker.open).toBe(false);
    breaker.recordFailure();
    expect(breaker.open).toBe(false);
    breaker.recordFailure();
    expect(breaker.open).toBe(true);
    clock.advance(1_000);
    expect(breaker.open).toBe(false);
  });

  test("a success closes the circuit and resets the failure count", () => {
    const clock = fakeClock();
    const breaker = new InstallationCircuitBreaker(2, 1_000, clock.now);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.open).toBe(false);
  });
});
