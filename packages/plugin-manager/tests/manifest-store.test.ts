import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@soulcloud/core";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import { PrismaManifestStore } from "../src/manager";

const manifest: PluginManifest = {
  id: "example.plugin",
  version: "1.0.0",
  apiVersion: 1,
  profiles: [],
  actions: [],
  events: [],
};

describe("PrismaManifestStore", () => {
  test("returns the snapshot another Manager won the race to persist", async () => {
    const persisted = { manifestHash: "b".repeat(64), canonicalManifest: manifest };
    const prisma = {
      pluginManifestSnapshot: {
        create: async () => { throw Object.assign(new Error("localized database error"), { code: "P2002" }); },
        findUnique: async () => persisted,
      },
    } as unknown as PrismaClient;
    const store = new PrismaManifestStore(prisma);

    expect(await store.insert({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      manifestHash: "a".repeat(64),
      apiVersion: 1,
      manifest,
    })).toEqual({ manifestHash: persisted.manifestHash, manifest });
  });

  test("does not hide non-unique database failures", async () => {
    const failure = Object.assign(new Error("database unavailable"), { code: "P1001" });
    const prisma = {
      pluginManifestSnapshot: {
        create: async () => { throw failure; },
      },
    } as unknown as PrismaClient;
    const store = new PrismaManifestStore(prisma);

    await expect(store.insert({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      manifestHash: "a".repeat(64),
      apiVersion: 1,
      manifest,
    })).rejects.toBe(failure);
  });
});
