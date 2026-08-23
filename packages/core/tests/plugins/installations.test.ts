import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db";
import {
  bindDeviceToPluginInstallation,
  createPluginInstallation,
  migratePluginInstallation,
  reconcilePluginInstallation,
} from "../../src/plugins/installations";
import { applyEntityUpdates } from "../../src/plugins/entities";

const projectId = randomUUID();
const pluginId = `test.lifecycle.${randomUUID()}`;
const deviceIds = [randomUUID(), randomUUID()];
const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
let installationA: string;
let installationB: string;

function manifest(version: string, profileIds: string[]) {
  return {
    id: pluginId,
    version,
    apiVersion: 1,
    profiles: profileIds.map((id) => ({
      id,
      version: 1,
      manufacturer: "Soulcloud",
      model: id,
      capabilities: [],
      entities: [{ key: "temperature", valueType: "number", category: "measurement" }],
    })),
    actions: [],
    events: [],
  };
}

beforeAll(async () => {
  await prisma.project.create({ data: { id: projectId, name: "plugin lifecycle test" } });
  await prisma.device.createMany({
    data: deviceIds.map((id, index) => ({
      id,
      projectId,
      deviceUid: `plugin-lifecycle-${randomUUID()}`,
      assignedId: `plugin-lifecycle-${index}`,
      passwordHash: "unused",
    })),
  });
  await prisma.pluginManifestSnapshot.createMany({
    data: [
      { pluginId, pluginVersion: "1.0.0", manifestHash: hashes[0]!, apiVersion: 1, canonicalManifest: manifest("1.0.0", ["profile-a", "profile-b"]) },
      { pluginId, pluginVersion: "2.0.0", manifestHash: hashes[1]!, apiVersion: 1, canonicalManifest: manifest("2.0.0", ["profile-b"]) },
      { pluginId, pluginVersion: "3.0.0", manifestHash: hashes[2]!, apiVersion: 1, canonicalManifest: manifest("3.0.0", ["profile-c"]) },
    ],
  });
  installationA = (await createPluginInstallation(prisma, { projectId, pluginId, pluginVersion: "1.0.0", manifestHash: hashes[0]!, config: null })).id;
  const secondPluginId = `${pluginId}.second`;
  await prisma.pluginManifestSnapshot.create({
    data: { pluginId: secondPluginId, pluginVersion: "1.0.0", manifestHash: hashes[0]!, apiVersion: 1, canonicalManifest: { ...manifest("1.0.0", ["profile-b"]), id: secondPluginId } },
  });
  installationB = (await createPluginInstallation(prisma, { projectId, pluginId: secondPluginId, pluginVersion: "1.0.0", manifestHash: hashes[0]!, config: null })).id;
});

afterAll(async () => {
  await prisma.pluginDeviceBinding.deleteMany({ where: { deviceId: { in: deviceIds } } });
  await prisma.pluginInstallation.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.pluginManifestSnapshot.deleteMany({ where: { pluginId: { startsWith: pluginId } } });
});

describe("plugin installation lifecycle", () => {
  test("rebinding the last device deprecates descriptors in the old installation", async () => {
    await bindDeviceToPluginInstallation(prisma, { installationId: installationA, deviceId: deviceIds[0]!, profileId: "profile-a", profileVersion: 1 });
    await bindDeviceToPluginInstallation(prisma, { installationId: installationB, deviceId: deviceIds[0]!, profileId: "profile-b", profileVersion: 1 });

    const oldDescriptors = await prisma.pluginEntityDescriptor.findMany({ where: { installationId: installationA } });
    expect(oldDescriptors).toHaveLength(1);
    expect(oldDescriptors[0]!.deprecated).toBe(true);
  });

  test("migration rejects a manifest that drops a bound profile and rolls back", async () => {
    await bindDeviceToPluginInstallation(prisma, { installationId: installationA, deviceId: deviceIds[1]!, profileId: "profile-a", profileVersion: 1 });

    await expect(migratePluginInstallation(prisma, installationA, "2.0.0", hashes[1]!, null))
      .rejects.toThrow("bound profile profile-a@1");
    const installation = await prisma.pluginInstallation.findUniqueOrThrow({ where: { id: installationA } });
    expect(installation.pluginVersion).toBe("1.0.0");
    expect(installation.manifestHash.trim()).toBe(hashes[0]!);
  });

  test("does not overwrite Entity state with an already committed sequence", async () => {
    await prisma.$transaction((tx) => applyEntityUpdates(tx, {
      installationId: installationA,
      deviceId: deviceIds[1]!,
      profileId: "profile-a",
      profileVersion: 1,
      updates: [{ entityKey: "temperature", value: 20, sequence: 7n }],
    }));
    await prisma.$transaction((tx) => applyEntityUpdates(tx, {
      installationId: installationA,
      deviceId: deviceIds[1]!,
      profileId: "profile-a",
      profileVersion: 1,
      updates: [{ entityKey: "temperature", value: 99, sequence: 7n }],
    }));
    const state = await prisma.pluginEntityState.findUniqueOrThrow({
      where: {
        installationId_deviceId_entityKey: {
          installationId: installationA,
          deviceId: deviceIds[1]!,
          entityKey: "temperature",
        },
      },
    });
    expect(state.value).toBe(20);
  });

  test("clears current Entity state when the active profile changes", async () => {
    await bindDeviceToPluginInstallation(prisma, {
      installationId: installationA,
      deviceId: deviceIds[1]!,
      profileId: "profile-b",
      profileVersion: 1,
    });
    expect(await prisma.pluginEntityState.count({
      where: { installationId: installationA, deviceId: deviceIds[1]! },
    })).toBe(0);

    await prisma.$transaction((tx) => applyEntityUpdates(tx, {
      installationId: installationA,
      deviceId: deviceIds[1]!,
      profileId: "profile-b",
      profileVersion: 1,
      updates: [{ entityKey: "temperature", value: 30, sequence: 1n }],
    }));
    await bindDeviceToPluginInstallation(prisma, {
      installationId: installationA,
      deviceId: deviceIds[1]!,
      profileId: "profile-b",
      profileVersion: 1,
    });
    expect(await prisma.pluginEntityState.count({
      where: { installationId: installationA, deviceId: deviceIds[1]! },
    })).toBe(1);
  });

  test("reconcile reports a binding that is not in the pinned manifest", async () => {
    await prisma.pluginDeviceBinding.update({ where: { deviceId: deviceIds[1]! }, data: { profileId: "missing-profile" } });
    await expect(reconcilePluginInstallation(prisma, installationA))
      .rejects.toThrow("bound profile missing-profile@1");
  });
});
