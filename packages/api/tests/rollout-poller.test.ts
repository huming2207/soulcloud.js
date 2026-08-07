/**
 * Rollout poller tests (Kimi round-7 P1-4): the poller file had zero
 * coverage. The advance function is mocked so the poller's own behavior
 * is what is under test: pass logging, error isolation (a failing pass
 * must not crash the loop), re-entrancy (no overlapping passes), and
 * stop semantics.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AdvanceSummary } from "@soulcloud/core";
import type { RolloutPollerLog } from "../src/rollout-poller";

const advanceRollouts = mock(async (): Promise<AdvanceSummary> => ({
  rolloutsScanned: 1,
  phasesActivated: 0,
  phasesCompleted: 0,
  rolloutsPaused: 0,
  rolloutsCompleted: 0,
  targetsStalled: 0,
  rolloutsErrored: 0,
}));

mock.module("@soulcloud/core", () => ({
  advanceRollouts,
}));

const { startRolloutPoller } = await import("../src/rollout-poller");

interface Entry {
  level: "info" | "warn";
  msg: string;
}

function makeLog(): RolloutPollerLog & { entries: Entry[] } {
  const entries: Entry[] = [];
  const rec = (level: Entry["level"]) => (msg: string) => {
    entries.push({ level, msg });
  };
  return { info: rec("info"), warn: rec("warn"), entries };
}

afterEach(() => {
  advanceRollouts.mockClear();
});

describe("startRolloutPoller", () => {
  test("logs a summary when a pass did work", async () => {
    advanceRollouts.mockImplementation(async () => ({
      rolloutsScanned: 2,
      phasesActivated: 1,
      phasesCompleted: 0,
      rolloutsPaused: 0,
      rolloutsCompleted: 0,
      targetsStalled: 0,
      rolloutsErrored: 0,
    }));
    const log = makeLog();
    const poller = startRolloutPoller({} as never, { pollIntervalMs: 20 }, log);
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();
    expect(advanceRollouts.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(log.entries.some((e) => e.level === "info" && e.msg === "rollout advance pass")).toBe(
      true,
    );
  });

  test("a failing pass is logged and the loop keeps running", async () => {
    let calls = 0;
    advanceRollouts.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("db hiccup");
      return {
        rolloutsScanned: 0,
        phasesActivated: 0,
        phasesCompleted: 0,
        rolloutsPaused: 0,
        rolloutsCompleted: 0,
        targetsStalled: 0,
        rolloutsErrored: 0,
      };
    });
    const log = makeLog();
    const poller = startRolloutPoller({} as never, { pollIntervalMs: 20 }, log);
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // first pass failed, later ones ran
    expect(log.entries.some((e) => e.level === "warn" && e.msg === "rollout advance pass failed")).toBe(
      true,
    );
  });

  test("passes never overlap (re-entrancy guard)", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    advanceRollouts.mockImplementation(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return {
        rolloutsScanned: 0,
        phasesActivated: 0,
        phasesCompleted: 0,
        rolloutsPaused: 0,
        rolloutsCompleted: 0,
        targetsStalled: 0,
        rolloutsErrored: 0,
      };
    });
    const log = makeLog();
    const poller = startRolloutPoller({} as never, { pollIntervalMs: 5 }, log);
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBe(1);
  });

  test("stop() halts further passes", async () => {
    let calls = 0;
    advanceRollouts.mockImplementation(async () => {
      calls += 1;
      return {
        rolloutsScanned: 0,
        phasesActivated: 0,
        phasesCompleted: 0,
        rolloutsPaused: 0,
        rolloutsCompleted: 0,
        targetsStalled: 0,
        rolloutsErrored: 0,
      };
    });
    const log = makeLog();
    const poller = startRolloutPoller({} as never, { pollIntervalMs: 10 }, log);
    await new Promise((r) => setTimeout(r, 50));
    poller.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(after);
  });
});
