import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  bindDeviceToInstallation,
  createInstallation,
  resolveDeviceBinding,
  BUILTIN_PROFILE_ID,
  BUILTIN_PLUGIN_ID,
} from "../../src/plugins/installation";
import {
  enqueuePluginEvent,
  failPluginEvent,
  leaseNextPluginEvent,
  completePluginEvent,
  recoverExpiredPluginEventLeases,
  listInstallationsWithWork,
  sweepInstallationVersions,
} from "../../src/plugins/events-queue";
import { PluginSystemError } from "../../src/plugins/errors";
import { chaosTestPlugin } from "../../../../plugins/chaos-test";

// Integration tests against the isolated test database (scripts/test.sh).

let projectId: string;
let deviceId: string;
let installationId: string;
let unboundDeviceId: string;

async function createDevice(assignedId: string): Promise<string> {
  const id = randomUUID();
  await prisma.device.create({
    data: {
      id,
      deviceUid: `evq-${randomUUID().slice(0, 12)}`,
      assignedId,
      passwordHash: "unused",
      projectId,
    },
  });
  return id;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "events-queue-test" } });
  const installation = await createInstallation(prisma, {
    projectId,
    manifest: chaosTestPlugin,
    configJson: { line: "test-line" },
  });
  installationId = installation.id;
  deviceId = await createDevice("events-device");
  await bindDeviceToInstallation(prisma, {
    deviceId,
    installationId,
    profileId: chaosTestPlugin.profiles[0]!.id,
    profileVersion: chaosTestPlugin.profiles[0]!.version,
  });
  unboundDeviceId = await createDevice("events-unbound");
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM plugin_events WHERE plugin_installation_id = ${installationId}`;
  await prisma.$executeRaw`DELETE FROM entity_history WHERE device_id = ${deviceId}`;
  await prisma.$executeRaw`DELETE FROM entity_current_state`;
  await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${deviceId}`;
  await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = ${chaosTestPlugin.id}`;
  await prisma.$executeRaw`DELETE FROM plugin_installations WHERE project_id = ${projectId}`;
  await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${projectId}`;
  await prisma.$executeRaw`DELETE FROM projects WHERE id = ${projectId}`;
});

// Each test enqueues its own events; earlier tests' leftovers must not
// pollute FIFO assertions (every case below assumes a clean queue).
beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM plugin_events WHERE plugin_installation_id = ${installationId}`;
});

describe("resolveDeviceBinding", () => {
  test("unbound devices map to the builtin generic profile", async () => {
    const binding = await resolveDeviceBinding(prisma, unboundDeviceId);
    expect(binding.pluginId).toBe(BUILTIN_PLUGIN_ID);
    expect(binding.profileId).toBe(BUILTIN_PROFILE_ID);
    expect(binding.installationId).toBeNull();
  });

  test("bound devices resolve to their installation", async () => {
    const binding = await resolveDeviceBinding(prisma, deviceId);
    expect(binding.pluginId).toBe(chaosTestPlugin.id);
    expect(binding.installationId).toBe(installationId);
  });
});

describe("enqueuePluginEvent", () => {
  test("routes via the device binding and notifies", async () => {
    const result = await enqueuePluginEvent(prisma, {
      deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { value: 7 },
    });
    expect(result.duplicate).toBe(false);
    const row = await prisma.$queryRaw<{ plugin_installation_id: string; state: string }[]>`
      SELECT plugin_installation_id, state FROM plugin_events WHERE id = ${result.id}
    `;
    expect(row[0]!.plugin_installation_id).toBe(installationId);
    expect(row[0]!.state).toBe("pending");
  });

  test("generic (unbound) devices cannot enqueue plugin events", async () => {
    expect(
      enqueuePluginEvent(prisma, {
        deviceId: unboundDeviceId,
        eventKind: "ok",
        schemaVersion: 1,
        payload: {},
      }),
    ).rejects.toThrow(PluginSystemError);
  });

  test("idempotency key deduplicates replays", async () => {
    const key = `idem-${randomUUID()}`;
    const first = await enqueuePluginEvent(prisma, {
      deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { n: 1 },
      idempotencyKey: key,
    });
    const second = await enqueuePluginEvent(prisma, {
      deviceId,
      eventKind: "ok",
      schemaVersion: 1,
      payload: { n: 1 },
      idempotencyKey: key,
    });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("rejects oversized payloads", async () => {
    expect(
      enqueuePluginEvent(prisma, {
        deviceId,
        eventKind: "ok",
        schemaVersion: 1,
        payload: { blob: "x".repeat(300 * 1024) },
      }),
    ).rejects.toThrow(PluginSystemError);
  });

  test("rejects events while the installation is not enabled", async () => {
    await prisma.$executeRaw`
      UPDATE plugin_installations SET state = 'draining' WHERE id = ${installationId}
    `;
    try {
      expect(
        enqueuePluginEvent(prisma, {
          deviceId,
          eventKind: "ok",
          schemaVersion: 1,
          payload: {},
        }),
      ).rejects.toThrow(PluginSystemError);
    } finally {
      await prisma.$executeRaw`
        UPDATE plugin_installations SET state = 'enabled' WHERE id = ${installationId}
      `;
    }
  });
});

describe("leasing", () => {
  test("leases per installation in FIFO order and counts attempts", async () => {
    const a = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    await Bun.sleep(5);
    const b = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    const first = await leaseNextPluginEvent(prisma, {
      pluginInstallationId: installationId,
      leaseDurationMs: 60_000,
    });
    expect(first?.id).toBe(a.id);
    expect(first?.attemptCount).toBe(1);
    expect(first?.pluginId).toBe(chaosTestPlugin.id);
    expect(first?.deviceUid).toBeTruthy();
    const second = await leaseNextPluginEvent(prisma, {
      pluginInstallationId: installationId,
      leaseDurationMs: 60_000,
    });
    expect(second?.id).toBe(b.id);
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id IN (${a.id}, ${b.id})`;
  });

  test("leased events are not leasable again", async () => {
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    const again = await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    expect(again?.id ?? null).not.toBe(e.id);
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });
});

describe("completion and failure", () => {
  test("complete applies updates atomically with the state change", async () => {
    // register the chaos entities for this device first
    const { registerDeviceEntities } = await import("../../src/plugins/entity");
    await registerDeviceEntities(prisma, deviceId, chaosTestPlugin.id, chaosTestPlugin.profiles[0]!);
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    const ok = await completePluginEvent(prisma, {
      eventId: e.id,
      applyUpdates: async (tx) => {
        await tx.$executeRaw`SELECT 1`; // side effects ride the same transaction
      },
    });
    expect(ok).toBe(true);
    const row = await prisma.$queryRaw<{ state: string; finished_at: Date | null }[]>`
      SELECT state, finished_at FROM plugin_events WHERE id = ${e.id}
    `;
    expect(row[0]!.state).toBe("completed");
    expect(row[0]!.finished_at).not.toBeNull();
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });

  test("transient failure schedules a backoff retry", async () => {
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "fail", schemaVersion: 1, payload: {} });
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    const outcome = await failPluginEvent(prisma, {
      eventId: e.id,
      error: "boom",
      permanent: false,
      maxAttempts: 3,
      backoffMs: 1_000,
    });
    expect(outcome.state).toBe("failed");
    const row = await prisma.$queryRaw<{ state: string; available_at: Date; last_error: string }[]>`
      SELECT state, available_at, last_error FROM plugin_events WHERE id = ${e.id}
    `;
    expect(row[0]!.state).toBe("failed");
    expect(row[0]!.available_at.getTime()).toBeGreaterThan(Date.now() - 100);
    expect(row[0]!.last_error).toBe("boom");
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });

  test("permanent failure dead-letters immediately", async () => {
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "huge", schemaVersion: 1, payload: {} });
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    const outcome = await failPluginEvent(prisma, {
      eventId: e.id,
      error: "response_too_large",
      permanent: true,
      maxAttempts: 5,
      backoffMs: 1_000,
    });
    expect(outcome.state).toBe("dead");
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });

  test("attempt exhaustion dead-letters", async () => {
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "fail", schemaVersion: 1, payload: {} });
    // attempt 1
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    await failPluginEvent(prisma, { eventId: e.id, error: "a1", permanent: false, maxAttempts: 2, backoffMs: 0 });
    // attempt 2 (available_at in the past)
    await prisma.$executeRaw`UPDATE plugin_events SET available_at = now() - interval '1 second' WHERE id = ${e.id}`;
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    const outcome = await failPluginEvent(prisma, { eventId: e.id, error: "a2", permanent: false, maxAttempts: 2, backoffMs: 0 });
    expect(outcome.state).toBe("dead");
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });

  test("expired leases recover, consuming the attempt", async () => {
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    await prisma.$executeRaw`
      UPDATE plugin_events SET lease_expires_at = now() - interval '1 second' WHERE id = ${e.id}
    `;
    const recovered = await recoverExpiredPluginEventLeases(prisma, { maxAttempts: 5 });
    expect(recovered).toBeGreaterThanOrEqual(1);
    const row = await prisma.$queryRaw<{ state: string; last_error: string }[]>`
      SELECT state, last_error FROM plugin_events WHERE id = ${e.id}
    `;
    expect(row[0]!.state).toBe("failed");
    expect(row[0]!.last_error).toContain("lease expired");
    await prisma.$executeRaw`DELETE FROM plugin_events WHERE id = ${e.id}`;
  });
});

describe("installation queries", () => {
  test("listInstallationsWithWork only reports installations with available events", async () => {
    const before = await listInstallationsWithWork(prisma);
    const e = await enqueuePluginEvent(prisma, { deviceId, eventKind: "ok", schemaVersion: 1, payload: {} });
    const after = await listInstallationsWithWork(prisma);
    expect(after.some((i) => i.id === installationId)).toBe(true);
    // lease + complete drains it again
    await leaseNextPluginEvent(prisma, { pluginInstallationId: installationId, leaseDurationMs: 60_000 });
    await completePluginEvent(prisma, { eventId: e.id, applyUpdates: async () => {} });
    const drained = await listInstallationsWithWork(prisma);
    expect(drained.some((i) => i.id === installationId)).toBe(false);
    void before;
  });

  test("sweepInstallationVersions errors drifted and missing plugins", async () => {
    // drifted: right plugin, wrong version
    const driftedProject = randomUUID();
    await prisma.project.create({ data: { id: driftedProject, name: "drift" } });
    await prisma.$executeRaw`
      INSERT INTO plugin_installations (id, project_id, plugin_id, configured_plugin_version, state, updated_at)
      VALUES (${randomUUID()}, ${driftedProject}, ${chaosTestPlugin.id}, '0.0.9', 'enabled', now())
    `;
    // missing: plugin not in the registry at all
    await prisma.$executeRaw`
      INSERT INTO plugin_installations (id, project_id, plugin_id, configured_plugin_version, state, updated_at)
      VALUES (${randomUUID()}, ${driftedProject}, 'acme.missing', '1.0.0', 'enabled', now())
    `;
    const deployed = new Map([[chaosTestPlugin.id, chaosTestPlugin.version]]);
    const errored = await sweepInstallationVersions(prisma, deployed);
    expect(errored.length).toBe(2);
    const states = await prisma.$queryRaw<{ state: string; error_detail: string }[]>`
      SELECT state, error_detail FROM plugin_installations WHERE project_id = ${driftedProject}
    `;
    expect(states.length).toBe(2);
    expect(states.every((s) => s.state === "error")).toBe(true);
    // the correctly-configured installation is untouched
    const mine = await prisma.$queryRaw<{ state: string }[]>`
      SELECT state FROM plugin_installations WHERE id = ${installationId}
    `;
    expect(mine[0]!.state).toBe("enabled");
    await prisma.$executeRaw`DELETE FROM plugin_installations WHERE project_id = ${driftedProject}`;
    await prisma.$executeRaw`DELETE FROM projects WHERE id = ${driftedProject}`;
  });
});
