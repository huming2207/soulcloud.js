import { describe, expect, test } from "bun:test";
import type { LeasedPluginEvent } from "@soulcloud/core";
import { PluginManager, type PluginEventStore } from "../src/manager";

function leasedEvent(id: string): LeasedPluginEvent {
  return {
    id,
    event_id: id,
    device_id: "device-id",
    device_uid: "device-uid",
    project_id: "project-id",
    seq: 1n,
    kind: "fixture.result",
    schema: 1,
    payload: Buffer.alloc(0),
    received_at: new Date(0),
    installation_id: "installation-id",
    plugin_id: "example.plugin",
    plugin_version: "1.0.0",
    manifest_hash: "hash",
    profile_id: "fixture",
    profile_version: 1,
    installation_config: {},
    attempt_count: 1,
    lease_token: `lease-${id}`,
  };
}

describe("plugin event consumer", () => {
  test("renews the current and pending events while draining a leased batch", async () => {
    const events = [leasedEvent("first"), leasedEvent("second")];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let renewed!: (leases: readonly { id: string; leaseToken: string }[]) => void;
    const renewalObserved = new Promise<readonly { id: string; leaseToken: string }[]>((resolve) => {
      renewed = resolve;
    });
    const store: PluginEventStore = {
      lease: async () => events,
      complete: async () => true,
      release: async () => true,
      renew: async (leases) => {
        renewed(leases);
        return leases.length;
      },
    };
    const manager = new PluginManager({
      endpoints: new Map(),
      authToken: "x".repeat(32),
      maxFrameBytes: 1024,
      maxPendingRequests: 8,
      backpressureBytes: 1024,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      reconnectMs: 1_000,
      eventStore: store,
      eventLeaseMs: 30,
    });
    const internals = manager as unknown as {
      consumeEventBatch(): Promise<void>;
      dispatchEvent(event: LeasedPluginEvent): Promise<void>;
    };
    const dispatched: string[] = [];
    internals.dispatchEvent = async (event) => {
      dispatched.push(event.id);
      if (event.id === "first") await firstBlocked;
    };

    const consuming = internals.consumeEventBatch();
    expect(await renewalObserved).toEqual([
      { id: "first", leaseToken: "lease-first" },
      { id: "second", leaseToken: "lease-second" },
    ]);
    releaseFirst();
    await consuming;
    expect(dispatched).toEqual(["first", "second"]);
  });
});
