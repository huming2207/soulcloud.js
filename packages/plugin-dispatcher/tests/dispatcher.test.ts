/**
 * Stage 2 integration tests (§17): the dispatcher runs against the
 * isolated test database and a real in-process WebSocket Plugin Host.
 *
 * The chaos plugin deliberately returns oversized responses and throws. The
 * dispatcher talks to a real in-process WebSocket Host, matching the container
 * transport without spawning child processes in the test runner.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createInstallation,
  bindDeviceToInstallation,
  enqueueBatch,
  leaseNext,
  prisma,
  registerDeviceEntities,
} from "@soulcloud/core";
import {
  enqueuePluginEvent,
  type PluginEventRow,
} from "@soulcloud/core";
import { chaosTestPlugin, CHAOS_PROFILE_ID, CHAOS_PROFILE_VERSION } from "@soulcloud/plugins";
import { startDispatcher, type DispatcherHandle } from "../src/dispatcher";
import { startPluginHost, type PluginHostHandle } from "../../plugin-host/src/server";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dispatcher: DispatcherHandle;
let host: PluginHostHandle;
const projects: string[] = [];
const devices: string[] = [];
const installations: string[] = [];

interface Fixture {
  projectId: string;
  deviceId: string;
  deviceUid: string;
  installationId: string;
}

async function makeFixture(name: string): Promise<Fixture> {
  const projectId = randomUUID();
  projects.push(projectId);
  await prisma.project.create({ data: { id: projectId, name } });
  const installation = await createInstallation(prisma, {
    projectId,
    manifest: chaosTestPlugin,
    configJson: { line: name },
  });
  installations.push(installation.id);
  const deviceId = randomUUID();
  const deviceUid = `disp-${randomUUID().slice(0, 12)}`;
  devices.push(deviceId);
  await prisma.device.create({
    data: {
      id: deviceId,
      deviceUid,
      assignedId: name,
      passwordHash: "unused",
      projectId,
    },
  });
  await bindDeviceToInstallation(prisma, {
    deviceId,
    installationId: installation.id,
    profileId: CHAOS_PROFILE_ID,
    profileVersion: CHAOS_PROFILE_VERSION,
    manifest: chaosTestPlugin,
  });
  await registerDeviceEntities(
    prisma,
    deviceId,
    chaosTestPlugin.id,
    chaosTestPlugin.profiles[0]!,
  );
  return { projectId, deviceId, deviceUid, installationId: installation.id };
}

async function eventState(id: string): Promise<{ state: string; attempt_count: number; last_error: string | null }> {
  const rows = await prisma.$queryRaw<
    { state: string; attempt_count: number; last_error: string | null }[]
  >`SELECT state, attempt_count, last_error FROM plugin_events WHERE id = ${id}`;
  return rows[0]!;
}

async function currentState(deviceId: string, entityKey: string): Promise<{ value: unknown; quality: string } | null> {
  const rows = await prisma.$queryRaw<
    { value: unknown; quality: string }[]
  >`
    SELECT cs.value, cs.quality
    FROM entity_registry er
    LEFT JOIN entity_current_state cs ON cs.entity_registry_id = er.id
    WHERE er.device_id = ${deviceId} AND er.entity_key = ${entityKey}
  `;
  return rows[0] ?? null;
}

async function until(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForHostReady(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await dispatcher.supervisor.ensureClient(
        chaosTestPlugin.id,
        chaosTestPlugin.version,
        chaosTestPlugin.apiVersion,
      );
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for plugin host recovery: ${(error as Error).message}`);
      }
      await Bun.sleep(50);
    }
  }
}

let main: Fixture;
let other: Fixture;

beforeAll(async () => {
  host = await startPluginHost({
    pluginId: chaosTestPlugin.id,
    hostname: "127.0.0.1",
    port: 0,
  });
  main = await makeFixture("dispatcher-main");
  other = await makeFixture("dispatcher-other");
  dispatcher = startDispatcher(
    prisma,
    {
      hostUrls: new Map([[chaosTestPlugin.id, host.wsUrl]]),
      hostAuthToken: undefined,
      pollIntervalMs: 50,
      leaseDurationMs: 60_000,
      eventTimeoutMs: 1_500,
      maxAttempts: 2,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      maxInFlight: 4,
      perInstallationConcurrency: 1,
      maxFrameBytes: 1024 * 1024,
      crashThreshold: 100, // never bench during tests
      crashWindowMs: 60_000,
      crashCooldownMs: 1_000,
      sweepIntervalMs: 500,
    },
    quietLogger,
    { breakerThreshold: 100, breakerCooldownMs: 500 },
  );
});

afterAll(async () => {
  await dispatcher.stop();
  await host.close();
  // deleting registry rows cascades current state + history
  await prisma.entityRegistry.deleteMany({
    where: { deviceId: { in: devices } },
  });
  await prisma.entityDescriptorRevision.deleteMany({
    where: { pluginId: chaosTestPlugin.id },
  });
  await prisma.pluginEvent.deleteMany({});
  // the command-queue test leaves a leased command on the fixture device
  await prisma.deviceCommand.deleteMany({ where: { deviceId: { in: devices } } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.pluginInstallation.deleteMany({
    where: { projectId: { in: projects } },
  });
  await prisma.device.deleteMany({ where: { projectId: { in: projects } } });
  await prisma.project.deleteMany({ where: { id: { in: projects } } });
});

describe("plugin dispatcher (stage 2 prototype)", () => {
  test("a healthy event completes and applies entity updates", async () => {
    const event = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 42 },
    });
    await until("event completed", async () =>
      (await eventState(event.id)).state === "completed",
    );
    const counter = await currentState(main.deviceId, "chaos.counter");
    expect(counter?.value).toBe(42);
    expect(counter?.quality).toBe("good");
    const lastKind = await currentState(main.deviceId, "chaos.last_kind");
    expect(lastKind?.value).toBe("ok");
  });

  test("handler errors retry with backoff, then dead-letter", async () => {
    const event = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "fail",
      schemaVersion: 1,
      payload: {},
    });
    await until("event dead", async () =>
      (await eventState(event.id)).state === "dead",
    );
    const state = await eventState(event.id);
    expect(state.attempt_count).toBe(2);
    expect(state.last_error).toContain("chaos failure");
  });

  test("a remote host handler failure is contained and work resumes", async () => {
    const crash = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "fail",
      schemaVersion: 1,
      payload: {},
    });
    await until("crash event dead", async () =>
      (await eventState(crash.id)).state === "dead",
    );
    const state = await eventState(crash.id);
    expect(state.attempt_count).toBe(2);
    expect(state.last_error).toContain("chaos failure");

    // The independent WebSocket host remains healthy after a failed request.
    const ok = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 7 },
    });
    await until("post-crash event completed", async () =>
      (await eventState(ok.id)).state === "completed",
    );
    expect((await currentState(main.deviceId, "chaos.counter"))?.value).toBe(7);
  });

  test("a slow remote handler is bounded by the request deadline", async () => {
    const hang = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "slow",
      schemaVersion: 1,
      payload: { ms: 2_000 },
    });
    const startedAt = Date.now();
    await until("hang event dead", async () =>
      (await eventState(hang.id)).state === "dead",
    );
    // The first remote call must actually reach its deadline. The second
    // attempt may be rejected by the supervisor's reconnect backoff, so do
    // not make the test depend on two full timeout windows.
    expect(Date.now() - startedAt).toBeGreaterThan(1_000);
    const state = await eventState(hang.id);
    expect(state.last_error).toMatch(/deadline exceeded|reconnect backoff/);
    // Isolate the following permanent-error tests from this intentionally
    // invalidated WebSocket connection and its reconnect backoff.
    await waitForHostReady();
  });

  test("oversized plugin output dead-letters permanently on the first attempt", async () => {
    // note: descriptor-valid output can never exceed the body ceiling
    // (layered caps), so the chaos "huge" event trips the VALUE cap —
    // still a permanent, first-attempt dead-letter.
    const huge = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "huge",
      schemaVersion: 1,
      payload: {},
    });
    await until("huge event dead", async () =>
      (await eventState(huge.id)).state === "dead",
    );
    const state = await eventState(huge.id);
    expect(state.attempt_count).toBe(1);
    expect(state.last_error).toMatch(/invalid plugin output|string exceeds/);
  });

  test("undeclared event kinds dead-letter permanently (routing validation)", async () => {
    const bogus = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "not-a-kind",
      schemaVersion: 1,
      payload: {},
    });
    await until("bogus event dead", async () =>
      (await eventState(bogus.id)).state === "dead",
    );
    const state = await eventState(bogus.id);
    expect(state.attempt_count).toBe(1);
    expect(state.last_error).toContain("not declared");
  });

  test("plugin output referencing undeclared entities dead-letters", async () => {
    const invalid = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "updates",
      schemaVersion: 1,
      payload: { updates: [{ entityKey: "chaos.nope", value: 1 }] },
    });
    await until("invalid event dead", async () =>
      (await eventState(invalid.id)).state === "dead",
    );
    expect((await eventState(invalid.id)).last_error).toContain("chaos.nope");
  });

  test("fairness: another installation progresses while one request is slow", async () => {
    const hang = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "slow",
      schemaVersion: 1,
      payload: { ms: 2_000 },
    });
    const ok = await enqueuePluginEvent(prisma, {
      deviceId: other.deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 11 },
    });
    await until("other installation completed while main is slow", async () =>
      (await eventState(ok.id)).state === "completed",
    );
    // the slow event has NOT completed while the other installation runs
    expect((await eventState(hang.id)).state).not.toBe("completed");
    expect((await currentState(other.deviceId, "chaos.counter"))?.value).toBe(11);
    await until("slow event dead (cleanup)", async () =>
      (await eventState(hang.id)).state === "dead",
    );
  });

  test("the command queue keeps working while a plugin request is slow", async () => {
    const hang = await enqueuePluginEvent(prisma, {
      deviceId: main.deviceId,
      eventKind: "slow",
      schemaVersion: 1,
      payload: { ms: 2_000 },
    });
    // wait until the slow event is actually in flight (leased)
    await until("slow event leased", async () =>
      ["leased", "failed", "dead"].includes((await eventState(hang.id)).state),
    );
    // the device doubles as a regular command target
    const batch = await enqueueBatch(prisma, [main.deviceId], {
      cmd: "ping",
      args: [],
    });
    const leased = await leaseNext(prisma, 60_000);
    expect(leased).not.toBeNull();
    expect(leased!.deviceUid).toBe(main.deviceUid);
    await until("slow event dead (cleanup)", async () =>
      (await eventState(hang.id)).state === "dead",
    );
    void batch;
  });

  test("stats reflect processed events", async () => {
    const stats = dispatcher.stats();
    expect(stats.processed).toBeGreaterThan(0);
    expect(stats.completed).toBeGreaterThan(0);
    expect(stats.deadLettered).toBeGreaterThan(0);
    expect(stats.inFlight).toBe(0);
  });

  test("entity-registry drift dead-letters permanently with a precise error (H2)", async () => {
    await waitForHostReady();
    const fixture = await makeFixture("dispatcher-drift");
    // simulate a lost reconcile: the manifest still declares the entities,
    // but this device's registry rows are gone
    await prisma.entityRegistry.deleteMany({ where: { deviceId: fixture.deviceId } });
    const event = await enqueuePluginEvent(prisma, {
      deviceId: fixture.deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 5 },
    });
    await until("drifted event dead", async () =>
      (await eventState(event.id)).state === "dead",
    );
    const state = await eventState(event.id);
    // deterministic outcome: one attempt, no retry burn, precise cause
    expect(state.attempt_count).toBe(1);
    expect(state.last_error).toContain("unknown_entity");
  });

  test("installation circuit breaker re-admits work after an idle cooldown (H1 regression)", async () => {
    // Pause the shared dispatcher so it cannot lease this fixture's events.
    await dispatcher.stop();
    const fixture = await makeFixture("dispatcher-breaker");
    const breakerDispatcher = startDispatcher(
      prisma,
      {
        hostUrls: new Map([[chaosTestPlugin.id, host.wsUrl]]),
        hostAuthToken: undefined,
        pollIntervalMs: 50,
        leaseDurationMs: 60_000,
        eventTimeoutMs: 1_500,
        maxAttempts: 2,
        backoffBaseMs: 100,
        backoffMaxMs: 1_000,
        maxInFlight: 4,
        perInstallationConcurrency: 1,
        maxFrameBytes: 1024 * 1024,
        crashThreshold: 100,
        crashWindowMs: 60_000,
        crashCooldownMs: 1_000,
        sweepIntervalMs: 500,
      },
      quietLogger,
      // two consecutive handler failures open the circuit; short cooldown
      { breakerThreshold: 2, breakerCooldownMs: 300 },
    );
    try {
      const fail1 = await enqueuePluginEvent(prisma, {
        deviceId: fixture.deviceId,
        eventKind: "fail",
        schemaVersion: 1,
        payload: {},
      });
      const fail2 = await enqueuePluginEvent(prisma, {
        deviceId: fixture.deviceId,
        eventKind: "fail",
        schemaVersion: 1,
        payload: {},
      });
      await until("both fail events dead-lettered", async () =>
        (await eventState(fail1.id)).state === "dead" &&
        (await eventState(fail2.id)).state === "dead",
      );
      // The queue is now EMPTY. Let the cooldown elapse while idle ticks
      // evaluate `open` repeatedly — under the old trial-slot semantics the
      // first of these ticks consumed the single trial and permanently
      // stalled this installation.
      await Bun.sleep(600);
      const okEvent = await enqueuePluginEvent(prisma, {
        deviceId: fixture.deviceId,
        eventKind: "ok",
        schemaVersion: 1,
        payload: { value: 99 },
      });
      await until("post-breaker event completed", async () =>
        (await eventState(okEvent.id)).state === "completed",
      );
      expect((await currentState(fixture.deviceId, "chaos.counter"))?.value).toBe(99);
    } finally {
      await breakerDispatcher.stop();
    }
  });

  test("permanent data errors do not open the installation circuit", async () => {
    const fixture = await makeFixture("dispatcher-permanent-breaker");
    const permanentDispatcher = startDispatcher(
      prisma,
      {
        hostUrls: new Map([[chaosTestPlugin.id, host.wsUrl]]),
        hostAuthToken: undefined,
        pollIntervalMs: 25,
        leaseDurationMs: 60_000,
        eventTimeoutMs: 1_500,
        maxAttempts: 2,
        backoffBaseMs: 100,
        backoffMaxMs: 1_000,
        maxInFlight: 2,
        perInstallationConcurrency: 1,
        maxFrameBytes: 1024 * 1024,
        crashThreshold: 100,
        crashWindowMs: 60_000,
        crashCooldownMs: 1_000,
        sweepIntervalMs: 500,
      },
      quietLogger,
      { breakerThreshold: 1, breakerCooldownMs: 10_000 },
    );
    try {
      const invalid = await enqueuePluginEvent(prisma, {
        deviceId: fixture.deviceId,
        eventKind: "not-a-kind",
        schemaVersion: 1,
        payload: {},
      });
      await until("permanent event dead", async () =>
        (await eventState(invalid.id)).state === "dead",
      );
      expect(permanentDispatcher.stats().openCircuits).not.toContain(fixture.installationId);

      const healthy = await enqueuePluginEvent(prisma, {
        deviceId: fixture.deviceId,
        eventKind: "ok",
        schemaVersion: 1,
        payload: { value: 123 },
      });
      await until("healthy event completed", async () =>
        (await eventState(healthy.id)).state === "completed",
      );
    } finally {
      await permanentDispatcher.stop();
    }
  });
});

// keep PluginEventRow in the type surface (documents the lease shape)
export type { PluginEventRow };
