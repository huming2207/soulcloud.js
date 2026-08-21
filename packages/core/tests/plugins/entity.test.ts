import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import type { PrismaClient } from "../../src/db";
import {
  applyEntityUpdate,
  canonicalDescriptor,
  ensureEntityDescriptors,
  getDeviceEntityHistory,
  getDeviceEntityStates,
  registerDeviceEntities,
} from "../../src/plugins/entity";
import { PluginSystemError } from "../../src/plugins/errors";
import type { DeviceProfileDescriptor, EntityDescriptor } from "@soulcloud/plugin-sdk";

// Integration tests against the isolated test database (scripts/test.sh).

const PLUGIN_ID = "test.entity-plugin";

function descriptor(overrides: Partial<EntityDescriptor> = {}): EntityDescriptor {
  return {
    key: "fixture.voltage",
    valueType: "number",
    access: "read",
    category: "measurement",
    unit: "V",
    history: "all",
    ...overrides,
  };
}

const profile: DeviceProfileDescriptor = {
  id: "fixture_v1",
  version: 1,
  manufacturer: "Test",
  model: "Fixture",
  capabilities: ["test"],
  entities: [
    descriptor(), // fixture.voltage — history: all
    descriptor({ key: "fixture.mode", valueType: "enum", enumValues: ["standby", "running"], history: "changes" }),
    descriptor({ key: "fixture.counter", category: "counter", history: "changes" }),
    descriptor({ key: "fixture.sampled", history: "sampled", sampleIntervalSeconds: 60 }),
  ],
};

let projectId: string;
let deviceId: string;

async function cleanup(prisma: PrismaClient) {
  await prisma.$executeRaw`DELETE FROM entity_history WHERE device_id = ${deviceId}`;
  await prisma.$executeRaw`DELETE FROM entity_current_state`;
  await prisma.$executeRaw`DELETE FROM entity_registry WHERE device_id = ${deviceId}`;
  await prisma.$executeRaw`DELETE FROM entity_descriptor_revisions WHERE plugin_id = ${PLUGIN_ID}`;
  await prisma.$executeRaw`DELETE FROM devices WHERE project_id = ${projectId}`;
  await prisma.$executeRaw`DELETE FROM projects WHERE id = ${projectId}`;
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "entity-test" } });
  deviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: deviceId,
      deviceUid: `ent-${randomUUID().slice(0, 12)}`,
      assignedId: "entity-device",
      passwordHash: "unused",
      projectId,
    },
  });
});

afterAll(async () => {
  await cleanup(prisma);
});

describe("descriptor revisions", () => {
  test("registering twice is idempotent (same revision)", async () => {
    await registerDeviceEntities(prisma, deviceId, PLUGIN_ID, profile);
    const first = await ensureEntityDescriptors(prisma, PLUGIN_ID, profile);
    await registerDeviceEntities(prisma, deviceId, PLUGIN_ID, profile);
    const second = await ensureEntityDescriptors(prisma, PLUGIN_ID, profile);
    for (const key of first.keys()) {
      expect(first.get(key)).toBe(second.get(key));
    }
    const revisions = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entity_descriptor_revisions WHERE plugin_id = ${PLUGIN_ID}
    `;
    expect(revisions[0]!.count).toBe(profile.entities.length);
  });

  test("a changed descriptor creates a new revision and repoints the registry", async () => {
    const changed: DeviceProfileDescriptor = {
      ...profile,
      entities: [
        descriptor({ unit: "mV" }), // unit change: incompatible -> new revision
        ...profile.entities.slice(1),
      ],
    };
    const before = await ensureEntityDescriptors(prisma, PLUGIN_ID, profile);
    await registerDeviceEntities(prisma, deviceId, PLUGIN_ID, changed);
    const after = await ensureEntityDescriptors(prisma, PLUGIN_ID, changed);
    expect(after.get("fixture.voltage")).not.toBe(before.get("fixture.voltage"));
    // unchanged entities keep their revision
    expect(after.get("fixture.mode")).toBe(before.get("fixture.mode"));
    // registry points at the new revision
    const row = await prisma.$queryRaw<{ descriptor_revision_id: string }[]>`
      SELECT descriptor_revision_id FROM entity_registry
      WHERE device_id = ${deviceId} AND plugin_id = ${PLUGIN_ID} AND entity_key = 'fixture.voltage'
    `;
    expect(row[0]!.descriptor_revision_id).toBe(after.get("fixture.voltage") ?? "");
  });

  test("canonical form ignores key order", () => {
    const a = descriptor();
    const b: EntityDescriptor = {
      access: "read",
      category: "measurement",
      history: "all",
      key: "fixture.voltage",
      unit: "V",
      valueType: "number",
    };
    expect(canonicalDescriptor(a)).toBe(canonicalDescriptor(b));
  });
});

describe("applyEntityUpdate policies", () => {
  test("history=all appends every update and upserts current state", async () => {
    await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.voltage", value: 3.3, quality: "good" },
    });
    await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.voltage", value: 3.4, quality: "good", alarm: { level: "warning", code: "OVER" } },
    });
    const states = await getDeviceEntityStates(prisma, deviceId);
    const voltage = states.find((s) => s.entityKey === "fixture.voltage");
    expect(voltage?.value).toBe(3.4);
    expect(voltage?.alarmLevel).toBe("warning");
    expect(voltage?.alarmCode).toBe("OVER");
    const history = await getDeviceEntityHistory(prisma, {
      deviceId,
      entityKey: "fixture.voltage",
    });
    expect(history.length).toBe(2);
    expect(history.every((h) => h.entityKey === "fixture.voltage")).toBe(true);
  });

  test("history=changes skips identical repeats", async () => {
    const update = { entityKey: "fixture.mode" as const, value: "running" };
    await applyEntityUpdate(prisma, { deviceId, pluginId: PLUGIN_ID, update });
    const r2 = await applyEntityUpdate(prisma, { deviceId, pluginId: PLUGIN_ID, update });
    expect(r2.historyAppended).toBe(false);
    expect(r2.skippedReason).toBe("unchanged");
    await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.mode", value: "standby" },
    });
    const history = await getDeviceEntityHistory(prisma, {
      deviceId,
      entityKey: "fixture.mode",
    });
    expect(history.length).toBe(2);
  });

  test("history=sampled suppresses rapid identical samples", async () => {
    await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.sampled", value: 1 },
    });
    const suppressed = await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.sampled", value: 1 },
    });
    expect(suppressed.historyAppended).toBe(false);
    // value change still recorded immediately
    const changed = await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.sampled", value: 2 },
    });
    expect(changed.historyAppended).toBe(true);
  });

  test("rejects values violating the descriptor", async () => {
    await expect(
      applyEntityUpdate(prisma, {
        deviceId,
        pluginId: PLUGIN_ID,
        update: { entityKey: "fixture.mode", value: "fault" },
      }),
    ).rejects.toThrow(PluginSystemError);
    await expect(
      applyEntityUpdate(prisma, {
        deviceId,
        pluginId: PLUGIN_ID,
        update: { entityKey: "fixture.voltage", value: "not-a-number" },
      }),
    ).rejects.toThrow(PluginSystemError);
  });

  test("rejects updates for unregistered entities", async () => {
    await expect(
      applyEntityUpdate(prisma, {
        deviceId,
        pluginId: PLUGIN_ID,
        update: { entityKey: "fixture.unknown", value: 1 },
      }),
    ).rejects.toThrow(PluginSystemError);
  });

  test("history rows record the descriptor revision in force", async () => {
    // all rows so far were written after the voltage descriptor moved to
    // revision 2 (unit change in the describe block above)
    const before = await getDeviceEntityHistory(prisma, {
      deviceId,
      entityKey: "fixture.voltage",
    });
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((h) => h.descriptorRevision === 2)).toBe(true);

    // change the descriptor again: new writes record revision 3, old rows
    // keep their revision (§4.1: never re-interpret old data)
    const changedAgain: DeviceProfileDescriptor = {
      ...profile,
      entities: [
        descriptor({ unit: "kV" }),
        ...profile.entities.slice(1),
      ],
    };
    await registerDeviceEntities(prisma, deviceId, PLUGIN_ID, changedAgain);
    await applyEntityUpdate(prisma, {
      deviceId,
      pluginId: PLUGIN_ID,
      update: { entityKey: "fixture.voltage", value: 9.9 },
    });
    const history = await getDeviceEntityHistory(prisma, {
      deviceId,
      entityKey: "fixture.voltage",
    });
    const revisions = history.map((h) => h.descriptorRevision);
    expect(revisions).toContain(2);
    expect(revisions).toContain(3);
    // voltage entity itself is now on revision 3
    const registry = await prisma.$queryRaw<{ revision: number }[]>`
      SELECT rev.revision FROM entity_registry er
      INNER JOIN entity_descriptor_revisions rev ON rev.id = er.descriptor_revision_id
      WHERE er.device_id = ${deviceId} AND er.entity_key = 'fixture.voltage'
    `;
    expect(registry[0]!.revision).toBe(3);
  });
});

describe("queries", () => {
  test("keyset pagination by afterId", async () => {
    const all = await getDeviceEntityHistory(prisma, { deviceId });
    expect(all.length).toBeGreaterThan(2);
    const page = await getDeviceEntityHistory(prisma, {
      deviceId,
      afterId: BigInt(all[0]!.id),
      limit: 2,
    });
    expect(page.length).toBe(2);
    expect(page[0]!.id).toBe(all[1]!.id);
  });

  test("states cover all registered entities of the device", async () => {
    const states = await getDeviceEntityStates(prisma, deviceId);
    const keys = states.map((s) => s.entityKey).sort();
    expect(keys).toEqual([
      "fixture.counter",
      "fixture.mode",
      "fixture.sampled",
      "fixture.voltage",
    ]);
  });
});
