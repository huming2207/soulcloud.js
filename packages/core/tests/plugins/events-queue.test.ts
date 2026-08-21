import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  bindDeviceToInstallation,
  createInstallation,
  resolveDeviceBinding,
  BUILTIN_PROFILE_ID,
  BUILTIN_PLUGIN_ID,
  setInstallationState,
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
import {
  applyEntityUpdate,
  getDeviceEntityStates,
} from "../../src/plugins/entity";
import {
  migrateInstallationInTransaction,
  reconcileInstallationDevices,
} from "../../src/plugins/installation";
import { chaosTestPlugin } from "../../../../plugins/chaos-test";
import type { PluginManifest } from "@soulcloud/plugin-sdk";

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
    manifest: chaosTestPlugin,
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

describe("bindDeviceToInstallation validation (H2)", () => {
  test("rejects a manifest from a different plugin", async () => {
    const impostor = { ...chaosTestPlugin, id: "acme.other" };
    await expect(
      bindDeviceToInstallation(prisma, {
        deviceId,
        installationId,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: impostor,
      }),
    ).rejects.toMatchObject({ kind: "unknown_plugin" });
  });

  test("rejects profiles the manifest does not declare", async () => {
    await expect(
      bindDeviceToInstallation(prisma, {
        deviceId,
        installationId,
        profileId: "ghost_profile",
        profileVersion: 1,
        manifest: chaosTestPlugin,
      }),
    ).rejects.toMatchObject({ kind: "unknown_profile" });
  });

  test("registers the profile's entities for the device in the same transaction", async () => {
    const fresh = await createDevice("events-bind-register");
    const installed = await bindDeviceToInstallation(prisma, {
      deviceId: fresh,
      installationId,
      profileId: chaosTestPlugin.profiles[0]!.id,
      profileVersion: chaosTestPlugin.profiles[0]!.version,
      manifest: chaosTestPlugin,
    });
    expect(installed.installationId).toBe(installationId);
    const rows = await prisma.$queryRaw<{ entity_key: string }[]>`
      SELECT entity_key FROM entity_registry WHERE device_id = ${fresh} ORDER BY entity_key
    `;
    expect(rows.map((r) => r.entity_key)).toEqual(
      chaosTestPlugin.profiles[0]!.entities.map((e) => e.key).sort(),
    );
    await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${fresh}`;
  });
});

describe("reconcileInstallationDevices (H2)", () => {
  test("refreshes changed descriptors and deprecates removed keys", async () => {
    // isolated fixture so the shared installation stays untouched
    const recProject = randomUUID();
    await prisma.project.create({ data: { id: recProject, name: "reconcile-test" } });
    const recInstall = await createInstallation(prisma, {
      projectId: recProject,
      manifest: chaosTestPlugin,
      configJson: {},
    });
    const recDevice = randomUUID();
    await prisma.device.create({
      data: {
        id: recDevice,
        deviceUid: `rec-${randomUUID().slice(0, 12)}`,
        assignedId: "reconcile-device",
        passwordHash: "unused",
        projectId: recProject,
      },
    });
    const recDevice2 = randomUUID();
    await prisma.device.create({
      data: {
        id: recDevice2,
        deviceUid: `rec-${randomUUID().slice(0, 12)}`,
        assignedId: "reconcile-device-2",
        passwordHash: "unused",
        projectId: recProject,
      },
    });
    try {
      await bindDeviceToInstallation(prisma, {
        deviceId: recDevice,
        installationId: recInstall.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      });
      await bindDeviceToInstallation(prisma, {
        deviceId: recDevice2,
        installationId: recInstall.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      });

      // hotfix drift: same plugin/profile version, one descriptor changed,
      // one entity key removed entirely
      const base = chaosTestPlugin.profiles[0]!;
      const drifted = {
        ...chaosTestPlugin,
        profiles: [
          {
            ...base,
            entities: base.entities
              .filter((e) => e.key !== "chaos.mode")
              .map((e) => (e.key === "chaos.value" ? { ...e, unit: "mV" } : e)),
          },
        ],
      } as PluginManifest;

      const result = await reconcileInstallationDevices(prisma, {
        installationId: recInstall.id,
        manifest: drifted,
      });
      expect(result.devices).toBe(2);
      expect(result.missingProfiles).toEqual([]);
      expect(result.deprecatedRegistryRows).toBe(2);

      const rows = await prisma.$queryRaw<
        { entity_key: string; deprecated: boolean; unit: string | null }[]
      >`
        SELECT er.entity_key, er.deprecated, rev.descriptor->>'unit' AS unit
        FROM entity_registry er
        INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
        WHERE er.device_id = ${recDevice}
        ORDER BY er.entity_key
      `;
      const byKey = new Map(rows.map((r) => [r.entity_key, r]));
      expect(byKey.get("chaos.value")!.unit).toBe("mV");
      expect(byKey.get("chaos.mode")!.deprecated).toBe(true);
      expect(byKey.get("chaos.counter")!.deprecated).toBe(false);

      // §4.1: history semantics survive — the pre-drift revision still exists
      const oldRevisions = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM entity_descriptor_revisions
        WHERE plugin_id = ${chaosTestPlugin.id}
          AND entity_key = 'chaos.value' AND descriptor->>'unit' = 'V'
      `;
      expect(Number(oldRevisions[0]!.count)).toBe(1);
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_history WHERE device_id = ${recDevice}`;
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${recDevice}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE id = ${recInstall.id}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${recProject}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${recProject}`;
    }
  });

  test("refuses to reconcile against a different version", async () => {
    await expect(
      reconcileInstallationDevices(prisma, {
        installationId,
        manifest: { ...chaosTestPlugin, version: "9.9.9" },
      }),
    ).rejects.toMatchObject({ kind: "version_mismatch" });
  });

  test("reports bound profiles missing from the manifest without touching rows", async () => {
    const before = await prisma.$queryRaw<{ deprecated: boolean }[]>`
      SELECT deprecated FROM entity_registry WHERE device_id = ${deviceId} AND entity_key = 'chaos.counter'
    `;
    const result = await reconcileInstallationDevices(prisma, {
      installationId,
      manifest: { ...chaosTestPlugin, profiles: [] },
    });
    expect(result.devices).toBe(0);
    expect(result.missingProfiles).toEqual(["chaos_fixture@1"]);
    expect(result.deprecatedRegistryRows).toBe(0);
    const after = await prisma.$queryRaw<{ deprecated: boolean }[]>`
      SELECT deprecated FROM entity_registry WHERE device_id = ${deviceId} AND entity_key = 'chaos.counter'
    `;
    expect(after[0]!.deprecated).toBe(before[0]!.deprecated);
  });
});

describe("review-fix regressions (core)", () => {
  test("bind and disable serialize on the installation row", async () => {
    const raceProject = randomUUID();
    await prisma.project.create({ data: { id: raceProject, name: "bind-disable-race" } });
    const raceInstall = await createInstallation(prisma, {
      projectId: raceProject,
      manifest: chaosTestPlugin,
      configJson: {},
    });
    const raceDevice = randomUUID();
    await prisma.device.create({
      data: {
        id: raceDevice,
        deviceUid: `race-disable-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-bind-disable",
        passwordHash: "unused",
        projectId: raceProject,
      },
    });
    const completion: string[] = [];
    try {
      const disablePromise = setInstallationState(prisma, {
        installationId: raceInstall.id,
        state: "disabled",
      }).then(
        (value) => {
          completion.push("disable");
          return { ok: true as const, value };
        },
        (error) => {
          completion.push("disable");
          return { ok: false as const, error };
        },
      );
      const bindPromise = bindDeviceToInstallation(prisma, {
        deviceId: raceDevice,
        installationId: raceInstall.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      }).then(
        (value) => {
          completion.push("bind");
          return { ok: true as const, value };
        },
        (error) => {
          completion.push("bind");
          return { ok: false as const, error };
        },
      );
      const [disable, bind] = await Promise.all([disablePromise, bindPromise]);
      expect(disable.ok).toBe(true);
      expect(completion).toHaveLength(2);

      const device = await prisma.$queryRaw<{ plugin_installation_id: string | null }[]>`
        SELECT plugin_installation_id FROM devices WHERE id = ${raceDevice}
      `;
      if (bind.ok) {
        // A successful bind held the installation lock through its commit;
        // disable can only complete afterwards.
        expect(completion.indexOf("bind")).toBeLessThan(completion.indexOf("disable"));
        expect(device[0]!.plugin_installation_id).toBe(raceInstall.id);
      } else {
        expect(bind.error).toMatchObject({ kind: "installation_not_enabled" });
        expect(completion.indexOf("disable")).toBeLessThan(completion.indexOf("bind"));
        expect(device[0]!.plugin_installation_id).toBeNull();
      }
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${raceDevice}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE id = ${raceInstall.id}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE id = ${raceDevice}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${raceProject}`;
    }
  });

  test("bind and migrate serialize before profile validation", async () => {
    const raceProject = randomUUID();
    await prisma.project.create({ data: { id: raceProject, name: "bind-migrate-race" } });
    const raceInstall = await createInstallation(prisma, {
      projectId: raceProject,
      manifest: chaosTestPlugin,
      configJson: {},
    });
    const raceDevice = randomUUID();
    await prisma.device.create({
      data: {
        id: raceDevice,
        deviceUid: `race-migrate-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-bind-migrate",
        passwordHash: "unused",
        projectId: raceProject,
      },
    });
    const v2 = {
      ...chaosTestPlugin,
      version: "2.0.0",
      profiles: [],
    } as PluginManifest;
    try {
      const migrationPromise = prisma.$transaction((tx) =>
        migrateInstallationInTransaction(tx, {
          installationId: raceInstall.id,
          manifest: v2,
        }),
      ).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
      const bindPromise = bindDeviceToInstallation(prisma, {
        deviceId: raceDevice,
        installationId: raceInstall.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
      const [migration, bind] = await Promise.all([migrationPromise, bindPromise]);
      const installation = await prisma.$queryRaw<{ configured_plugin_version: string }[]>`
        SELECT configured_plugin_version
        FROM plugin_installations
        WHERE id = ${raceInstall.id}
      `;
      const device = await prisma.$queryRaw<{ plugin_installation_id: string | null }[]>`
        SELECT plugin_installation_id FROM devices WHERE id = ${raceDevice}
      `;
      if (migration.ok) {
        // Migration won the installation lock: bind must observe v2 and
        // reject, rather than commit a v1 profile against a v2 installation.
        expect(bind.ok).toBe(false);
        if (!bind.ok) {
          expect(bind.error).toMatchObject({ kind: "version_mismatch" });
        }
        expect(installation[0]!.configured_plugin_version).toBe("2.0.0");
        expect(device[0]!.plugin_installation_id).toBeNull();
      } else {
        // Bind won first: migration observes the locked device and rolls
        // back because v2 no longer declares its profile.
        expect(migration.error).toMatchObject({ kind: "migration_blocked" });
        expect(bind.ok).toBe(true);
        expect(installation[0]!.configured_plugin_version).toBe("1.0.0");
        expect(device[0]!.plugin_installation_id).toBe(raceInstall.id);
      }
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${raceDevice}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE id = ${raceInstall.id}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE id = ${raceDevice}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${raceProject}`;
    }
  });

  test("concurrent binds do not allocate duplicate descriptor revisions", async () => {
    const concurrentPlugin = {
      ...chaosTestPlugin,
      id: `acme.concurrent-${randomUUID()}`,
    } as PluginManifest;
    const projectA = randomUUID();
    const projectB = randomUUID();
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    await prisma.project.createMany({
      data: [
        { id: projectA, name: "concurrent-bind-a" },
        { id: projectB, name: "concurrent-bind-b" },
      ],
    });
    const [installA, installB] = await Promise.all([
      createInstallation(prisma, { projectId: projectA, manifest: concurrentPlugin }),
      createInstallation(prisma, { projectId: projectB, manifest: concurrentPlugin }),
    ]);
    for (const [id, projectIdForDevice, suffix] of [
      [deviceA, projectA, "a"],
      [deviceB, projectB, "b"],
    ] as const) {
      await prisma.device.create({
        data: {
          id,
          deviceUid: `race-concurrent-${suffix}-${randomUUID().slice(0, 8)}`,
          assignedId: `assigned-concurrent-${suffix}`,
          passwordHash: "unused",
          projectId: projectIdForDevice,
        },
      });
    }
    try {
      await Promise.all([
        bindDeviceToInstallation(prisma, {
          deviceId: deviceA,
          installationId: installA.id,
          profileId: concurrentPlugin.profiles[0]!.id,
          profileVersion: concurrentPlugin.profiles[0]!.version,
          manifest: concurrentPlugin,
        }),
        bindDeviceToInstallation(prisma, {
          deviceId: deviceB,
          installationId: installB.id,
          profileId: concurrentPlugin.profiles[0]!.id,
          profileVersion: concurrentPlugin.profiles[0]!.version,
          manifest: concurrentPlugin,
        }),
      ]);
      const revisions = await prisma.$queryRaw<{ count: number; max_revision: number }[]>`
        SELECT count(*)::int AS count, max(revision)::int AS max_revision
        FROM entity_descriptor_revisions
        WHERE plugin_id = ${concurrentPlugin.id}
      `;
      expect(revisions[0]!.count).toBe(concurrentPlugin.profiles[0]!.entities.length);
      expect(revisions[0]!.max_revision).toBe(1);
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id IN (${deviceA}, ${deviceB})`;
      await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = ${concurrentPlugin.id}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE id IN (${installA.id}, ${installB.id})`;
      await prisma.$executeRaw`DELETE FROM devices WHERE id IN (${deviceA}, ${deviceB})`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id IN (${projectA}, ${projectB})`;
    }
  });

  test("same-plugin profile switches close the registry deprecated lifecycle", async () => {
    const switchManifest = {
      id: `acme.profile-switch-${randomUUID()}`,
      version: "1.0.0",
      apiVersion: 1,
      profiles: [
        {
          id: "profile_a",
          version: 1,
          manufacturer: "Acme",
          model: "Switch A",
          capabilities: [],
          entities: [
            {
              key: "switch.a",
              valueType: "number",
              access: "read",
              category: "measurement",
              history: "none",
            },
          ],
        },
        {
          id: "profile_b",
          version: 1,
          manufacturer: "Acme",
          model: "Switch B",
          capabilities: [],
          entities: [
            {
              key: "switch.b",
              valueType: "string",
              access: "read",
              category: "diagnostic",
              history: "none",
            },
          ],
        },
      ],
      actions: [],
      events: [],
      workflows: [],
      ui: {},
    } as PluginManifest;
    const switchProject = randomUUID();
    const switchDevice = randomUUID();
    await prisma.project.create({ data: { id: switchProject, name: "profile-switch" } });
    const switchInstall = await createInstallation(prisma, {
      projectId: switchProject,
      manifest: switchManifest,
      configJson: {},
    });
    await prisma.device.create({
      data: {
        id: switchDevice,
        deviceUid: `profile-switch-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-profile-switch",
        passwordHash: "unused",
        projectId: switchProject,
      },
    });
    const profileA = switchManifest.profiles[0]!;
    const profileB = switchManifest.profiles[1]!;
    try {
      await bindDeviceToInstallation(prisma, {
        deviceId: switchDevice,
        installationId: switchInstall.id,
        profileId: profileA.id,
        profileVersion: profileA.version,
        manifest: switchManifest,
      });
      expect((await getDeviceEntityStates(prisma, switchDevice)).map((s) => s.entityKey)).toEqual([
        "switch.a",
      ]);

      await bindDeviceToInstallation(prisma, {
        deviceId: switchDevice,
        installationId: switchInstall.id,
        profileId: profileB.id,
        profileVersion: profileB.version,
        manifest: switchManifest,
      });
      let rows = await prisma.$queryRaw<{ entity_key: string; deprecated: boolean }[]>`
        SELECT entity_key, deprecated
        FROM entity_registry
        WHERE device_id = ${switchDevice}
          AND plugin_id = ${switchManifest.id}
        ORDER BY entity_key
      `;
      expect(rows).toEqual([
        { entity_key: "switch.a", deprecated: true },
        { entity_key: "switch.b", deprecated: false },
      ]);
      expect((await getDeviceEntityStates(prisma, switchDevice)).map((s) => s.entityKey)).toEqual([
        "switch.b",
      ]);
      await expect(
        applyEntityUpdate(prisma, {
          deviceId: switchDevice,
          pluginId: switchManifest.id,
          update: { entityKey: "switch.a", value: 1 },
        }),
      ).rejects.toMatchObject({ kind: "unknown_entity" });

      // Re-adding profile A must reactivate its existing registry row rather
      // than leaving it permanently deprecated after the profile round-trip.
      await bindDeviceToInstallation(prisma, {
        deviceId: switchDevice,
        installationId: switchInstall.id,
        profileId: profileA.id,
        profileVersion: profileA.version,
        manifest: switchManifest,
      });
      rows = await prisma.$queryRaw<{ entity_key: string; deprecated: boolean }[]>`
        SELECT entity_key, deprecated
        FROM entity_registry
        WHERE device_id = ${switchDevice}
          AND plugin_id = ${switchManifest.id}
        ORDER BY entity_key
      `;
      expect(rows).toEqual([
        { entity_key: "switch.a", deprecated: false },
        { entity_key: "switch.b", deprecated: true },
      ]);
      expect((await getDeviceEntityStates(prisma, switchDevice)).map((s) => s.entityKey)).toEqual([
        "switch.a",
      ]);
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${switchDevice}`;
      await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = ${switchManifest.id}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE id = ${switchInstall.id}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE id = ${switchDevice}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${switchProject}`;
    }
  });

  test("migration is blocked and rolled back when the new manifest drops a bound profile", async () => {
    const blkProject = randomUUID();
    await prisma.project.create({ data: { id: blkProject, name: "migrate-blocked" } });
    const inst = await createInstallation(prisma, {
      projectId: blkProject,
      manifest: chaosTestPlugin,
      configJson: {},
    });
    const dev = randomUUID();
    await prisma.device.create({
      data: {
        id: dev,
        deviceUid: `blk-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-blocked",
        passwordHash: "unused",
        projectId: blkProject,
      },
    });
    try {
      await bindDeviceToInstallation(prisma, {
        deviceId: dev,
        installationId: inst.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      });
      // v2 drops the bound profile entirely
      const v2 = { ...chaosTestPlugin, version: "2.0.0", profiles: [] } as PluginManifest;
      // the caller owns the transaction (same as the API route)
      await expect(
        prisma.$transaction((tx) =>
          migrateInstallationInTransaction(tx, { installationId: inst.id, manifest: v2 }),
        ),
      ).rejects.toMatchObject({ kind: "migration_blocked" });

      // rollback: version and state untouched
      const row = await prisma.$queryRaw<{ configured_plugin_version: string; state: string }[]>`
        SELECT configured_plugin_version, state FROM plugin_installations WHERE id = ${inst.id}
      `;
      expect(row[0]!.configured_plugin_version).toBe("1.0.0");
      expect(row[0]!.state).toBe("enabled");
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${dev}`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE project_id = ${blkProject}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${blkProject}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${blkProject}`;
    }
  });

  test("re-binding to another plugin deprecates the previous plugin's rows", async () => {
    const firstManifest = {
      id: "acme.first",
      version: "1.0.0",
      apiVersion: 1,
      profiles: [
        {
          id: "p1",
          version: 1,
          manufacturer: "Acme",
          model: "First",
          capabilities: [],
          entities: [
            { key: "first.value", valueType: "number", access: "read", category: "diagnostic", history: "none" },
          ],
        },
      ],
      actions: [],
      events: [],
      workflows: [],
      ui: {},
    } as PluginManifest;
    const xProject = randomUUID();
    await prisma.project.create({ data: { id: xProject, name: "cross-plugin" } });
    const firstInstall = await createInstallation(prisma, {
      projectId: xProject,
      manifest: firstManifest,
      configJson: {},
    });
    const chaosInstall = await createInstallation(prisma, {
      projectId: xProject,
      manifest: chaosTestPlugin,
      configJson: {},
    });
    const dev = randomUUID();
    await prisma.device.create({
      data: {
        id: dev,
        deviceUid: `xpl-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-cross",
        passwordHash: "unused",
        projectId: xProject,
      },
    });
    try {
      await bindDeviceToInstallation(prisma, {
        deviceId: dev,
        installationId: firstInstall.id,
        profileId: "p1",
        profileVersion: 1,
        manifest: firstManifest,
      });
      // switch the device to the chaos plugin
      await bindDeviceToInstallation(prisma, {
        deviceId: dev,
        installationId: chaosInstall.id,
        profileId: chaosTestPlugin.profiles[0]!.id,
        profileVersion: chaosTestPlugin.profiles[0]!.version,
        manifest: chaosTestPlugin,
      });
      const rows = await prisma.$queryRaw<{ plugin_id: string; deprecated: boolean }[]>`
        SELECT plugin_id, deprecated FROM entity_registry WHERE device_id = ${dev}
      `;
      const firstRows = rows.filter((r) => r.plugin_id === "acme.first");
      expect(firstRows.length).toBe(1);
      expect(firstRows.every((r) => r.deprecated)).toBe(true);
      const chaosRows = rows.filter((r) => r.plugin_id === chaosTestPlugin.id);
      expect(chaosRows.length).toBe(4);
      expect(chaosRows.every((r) => !r.deprecated)).toBe(true);
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${dev}`;
      await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = 'acme.first'`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE project_id = ${xProject}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${xProject}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${xProject}`;
    }
  });

  test("reconcile deprecation is scoped per profile group", async () => {
    const twoProfileManifest = {
      id: "acme.twoprofiles",
      version: "1.0.0",
      apiVersion: 1,
      profiles: [
        {
          id: "pa",
          version: 1,
          manufacturer: "Acme",
          model: "A",
          capabilities: [],
          entities: [
            { key: "shared.status", valueType: "number", access: "read", category: "diagnostic", history: "none" },
            { key: "a.only", valueType: "string", access: "read", category: "diagnostic", history: "none" },
          ],
        },
        {
          id: "pb",
          version: 1,
          manufacturer: "Acme",
          model: "B",
          capabilities: [],
          entities: [
            { key: "shared.status", valueType: "number", access: "read", category: "diagnostic", history: "none" },
            { key: "b.only", valueType: "number", access: "read", category: "diagnostic", history: "none" },
          ],
        },
      ],
      actions: [],
      events: [],
      workflows: [],
      ui: {},
    } as PluginManifest;
    // v1.0.1 keeps shared.status only on pb
    const upgraded = {
      ...twoProfileManifest,
      version: "1.0.1",
      profiles: [twoProfileManifest.profiles[1]],
    } as PluginManifest;

    const gProject = randomUUID();
    await prisma.project.create({ data: { id: gProject, name: "group-deprecation" } });
    const inst = await createInstallation(prisma, {
      projectId: gProject,
      manifest: twoProfileManifest,
      configJson: {},
    });
    const devA = randomUUID();
    const devB = randomUUID();
    for (const [id, suffix] of [[devA, "a"], [devB, "b"]] as const) {
      await prisma.device.create({
        data: {
          id,
          deviceUid: `grp-${suffix}-${randomUUID().slice(0, 8)}`,
          assignedId: `assigned-group-${suffix}`,
          passwordHash: "unused",
          projectId: gProject,
        },
      });
    }
    try {
      await bindDeviceToInstallation(prisma, {
        deviceId: devA,
        installationId: inst.id,
        profileId: "pa",
        profileVersion: 1,
        manifest: twoProfileManifest,
      });
      await bindDeviceToInstallation(prisma, {
        deviceId: devB,
        installationId: inst.id,
        profileId: "pb",
        profileVersion: 1,
        manifest: twoProfileManifest,
      });

      // upgrade the installation to a manifest where pa no longer exists
      await prisma.$executeRaw`
        UPDATE plugin_installations SET configured_plugin_version = '1.0.1'
        WHERE id = ${inst.id}
      `;
      const result = await reconcileInstallationDevices(prisma, {
        installationId: inst.id,
        manifest: upgraded,
      });
      expect(result.devices).toBe(1); // only pb's device is reconcilable
      expect(result.missingProfiles).toEqual(["pa@1"]);
      // pa's group is skipped conservatively: its rows are left for the
      // operator (migration callers block + roll back on missing profiles)
      expect(result.deprecatedRegistryRows).toBe(0);

      const rowsA = await prisma.$queryRaw<{ deprecated: boolean }[]>`
        SELECT deprecated FROM entity_registry WHERE device_id = ${devA}
      `;
      expect(rowsA.every((r) => !r.deprecated)).toBe(true);

      const rows = await prisma.$queryRaw<{ entity_key: string; deprecated: boolean }[]>`
        SELECT er.entity_key, er.deprecated
        FROM entity_registry er WHERE er.device_id = ${devB}
      `;
      // pb still declares shared.status — it must stay active for devB
      const shared = rows.find((r) => r.entity_key === "shared.status");
      expect(shared?.deprecated).toBe(false);
    } finally {
      await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id IN (${devA}, ${devB})`;
      await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = 'acme.twoprofiles'`;
      await prisma.$executeRaw`DELETE FROM plugin_installations WHERE project_id = ${gProject}`;
      await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${gProject}`;
      await prisma.$executeRaw`DELETE FROM projects WHERE id = ${gProject}`;
    }
  });
});
