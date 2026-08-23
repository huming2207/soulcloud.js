import { describe, expect, test } from "bun:test";
import type { PluginManifest } from "@soulcloud/plugin-sdk";
import type { PluginConnection } from "../src/connection";
import { PluginManager, type ManifestStore } from "../src/manager";
import { canonicalJson, sha256Hex } from "@soulcloud/plugin-rpc-contract";

function manifest(version: string): PluginManifest {
  return { id: "example.plugin", version, apiVersion: 1, profiles: [], actions: [], events: [] };
}

describe("plugin catalog connection state", () => {
  test("marks only the exact connected version and hash as available", async () => {
    const first = manifest("1.0.0");
    const second = manifest("2.0.0");
    const firstHash = await sha256Hex(canonicalJson(first));
    const secondHash = await sha256Hex(canonicalJson(second));
    const store: ManifestStore = {
      list: async () => [
        { pluginId: first.id, pluginVersion: first.version, manifestHash: firstHash, manifest: first },
        { pluginId: second.id, pluginVersion: second.version, manifestHash: secondHash, manifest: second },
      ],
      get: async () => null,
      insert: async () => { throw new Error("not used"); },
    };
    const manager = new PluginManager({
      endpoints: new Map(), authToken: "x".repeat(32), maxFrameBytes: 1024,
      maxPendingRequests: 8, backpressureBytes: 1024, heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000, reconnectMs: 1000, manifestStore: store,
    });
    await manager.start();
    const internals = manager as unknown as { connections: Map<string, PluginConnection> };
    internals.connections.set(first.id, {
      isOpen: true,
      manifest: { pluginVersion: second.version, manifestHash: secondHash },
    } as unknown as PluginConnection);

    expect(manager.listCatalog().map((entry) => [entry.pluginVersion, entry.connected]))
      .toEqual([["1.0.0", false], ["2.0.0", true]]);
  });
});
