import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import { completePluginEventWithUpdates } from "../../src/plugins/events";
import {
  bindDeviceToPluginInstallation,
  createPluginInstallation,
  migratePluginInstallation,
} from "../../src/plugins/installations";

const projects: string[] = [];

function manifest(
  pluginId: string,
  version: string,
  profiles: Array<{ id: string; valueType: "number" | "string" }>,
) {
  return {
    id: pluginId,
    version,
    apiVersion: 1,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      version: 1,
      manufacturer: "Soulcloud",
      model: profile.id,
      capabilities: [],
      entities: [{
        key: "temperature",
        valueType: profile.valueType,
        category: "measurement" as const,
        history: "all" as const,
      }],
    })),
    actions: [],
    events: [{ kind: "fixture.result", schemaVersion: 1 }],
  };
}

async function fixture() {
  const projectId = randomUUID();
  const deviceId = randomUUID();
  const pluginId = `test.event-completion.${randomUUID()}`;
  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  const oldManifest = manifest(pluginId, "1.0.0", [
    { id: "profile-a", valueType: "number" },
    { id: "profile-b", valueType: "number" },
  ]);
  const newManifest = manifest(pluginId, "2.0.0", [
    { id: "profile-a", valueType: "string" },
    { id: "profile-b", valueType: "number" },
  ]);
  projects.push(projectId);
  await prisma.project.create({ data: { id: projectId, name: "plugin event completion test" } });
  await prisma.device.create({
    data: {
      id: deviceId,
      projectId,
      deviceUid: `plugin-event-completion-${randomUUID()}`,
      assignedId: "fixture",
      passwordHash: "unused",
    },
  });
  await prisma.pluginManifestSnapshot.createMany({
    data: [
      { pluginId, pluginVersion: "1.0.0", manifestHash: oldHash, apiVersion: 1, canonicalManifest: oldManifest },
      { pluginId, pluginVersion: "2.0.0", manifestHash: newHash, apiVersion: 1, canonicalManifest: newManifest },
    ],
  });
  const installationId = (await createPluginInstallation(prisma, {
    projectId,
    pluginId,
    pluginVersion: "1.0.0",
    manifestHash: oldHash,
    config: null,
  })).id;
  await bindDeviceToPluginInstallation(prisma, {
    installationId,
    deviceId,
    profileId: "profile-a",
    profileVersion: 1,
  });
  return { projectId, deviceId, pluginId, oldHash, newHash, oldManifest, installationId };
}

async function leasedEvent(input: {
  installationId: string;
  deviceId: string;
  pluginId: string;
  manifestHash: string;
}) {
  return prisma.pluginEvent.create({
    data: {
      eventId: randomUUID().replaceAll("-", ""),
      deviceId: input.deviceId,
      seq: "1",
      kind: "fixture.result",
      schema: 1,
      payload: new Uint8Array(),
      installationId: input.installationId,
      pluginId: input.pluginId,
      pluginVersion: "1.0.0",
      manifestHash: input.manifestHash,
      profileId: "profile-a",
      profileVersion: 1,
      installationConfig: {},
      state: "leased",
      leaseToken: "lease-token",
    },
  });
}

afterEach(async () => {
  const projectIds = projects.splice(0);
  if (projectIds.length === 0) return;
  const batches = await prisma.commandBatch.findMany({
    where: { commands: { some: { device: { projectId: { in: projectIds } } } } },
    select: { id: true },
  });
  await prisma.commandBatch.deleteMany({ where: { id: { in: batches.map((batch) => batch.id) } } });
  await prisma.pluginEvent.deleteMany({ where: { device: { projectId: { in: projectIds } } } });
  await prisma.pluginDeviceBinding.deleteMany({ where: { device: { projectId: { in: projectIds } } } });
  await prisma.pluginInstallation.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.device.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.pluginManifestSnapshot.deleteMany({ where: { pluginId: { startsWith: "test.event-completion." } } });
});

describe("plugin event completion lifecycle snapshots", () => {
  test("keeps old history without restoring current state after a profile rebind", async () => {
    const data = await fixture();
    const event = await leasedEvent({ ...data, manifestHash: data.oldHash });
    await bindDeviceToPluginInstallation(prisma, {
      installationId: data.installationId,
      deviceId: data.deviceId,
      profileId: "profile-b",
      profileVersion: 1,
    });

    expect(await completePluginEventWithUpdates(prisma, event.id, "lease-token", {
      installationId: data.installationId,
      deviceId: data.deviceId,
      pluginId: data.pluginId,
      pluginVersion: "1.0.0",
      manifestHash: data.oldHash,
      profileId: "profile-a",
      profileVersion: 1,
      snapshotDescriptors: data.oldManifest.profiles[0]!.entities,
      updates: [{ entityKey: "temperature", value: 21, quality: "good", sequence: 1n }],
    })).toBe(true);

    expect(await prisma.pluginEntityState.count({
      where: { installationId: data.installationId, deviceId: data.deviceId },
    })).toBe(0);
    const history = await prisma.pluginEntityHistory.findMany({
      where: { installationId: data.installationId, deviceId: data.deviceId },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.value).toBe(21);
    expect(history[0]!.descriptorRevision).toBe(1);
  });

  test("uses the immutable old descriptor after installation migration", async () => {
    const data = await fixture();
    const event = await leasedEvent({ ...data, manifestHash: data.oldHash });
    await migratePluginInstallation(
      prisma,
      data.installationId,
      "2.0.0",
      data.newHash,
      null,
    );

    expect(await completePluginEventWithUpdates(prisma, event.id, "lease-token", {
      installationId: data.installationId,
      deviceId: data.deviceId,
      pluginId: data.pluginId,
      pluginVersion: "1.0.0",
      manifestHash: data.oldHash,
      profileId: "profile-a",
      profileVersion: 1,
      snapshotDescriptors: data.oldManifest.profiles[0]!.entities,
      updates: [{ entityKey: "temperature", value: 22, quality: "good", sequence: 2n }],
      commands: [{ deviceId: data.deviceId, command: { cmd: "record_result" } }],
    })).toBe(true);

    expect(await prisma.pluginEntityState.count({
      where: { installationId: data.installationId, deviceId: data.deviceId },
    })).toBe(0);
    const history = await prisma.pluginEntityHistory.findMany({
      where: { installationId: data.installationId, deviceId: data.deviceId },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.value).toBe(22);
    expect(history[0]!.descriptorRevision).toBe(1);
    expect(await prisma.deviceCommand.count({ where: { deviceId: data.deviceId } })).toBe(1);
  });
});
