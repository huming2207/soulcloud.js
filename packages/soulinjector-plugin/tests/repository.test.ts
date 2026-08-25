import { describe, expect, test } from "bun:test";
import type { Pool, PoolClient } from "pg";
import { DebugSessionConflictError, SoulInjectorRepository } from "../src/repository";

function fakePool(failMigration = false): { pool: Pool; queries: string[]; released: boolean } {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (query: string) => {
      queries.push(query);
      if (failMigration && query.includes("CREATE SCHEMA IF NOT EXISTS")) throw new Error("migration failed");
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    get released() { return released; },
  };
}

describe("SoulInjector private repository migration", () => {
  test("runs BEGIN, migration and COMMIT on the same checked-out client", async () => {
    const fake = fakePool();
    await new SoulInjectorRepository(fake.pool).migrate();
    expect(fake.queries[0]).toBe("BEGIN");
    expect(fake.queries[1]).toStartWith("\nCREATE SCHEMA IF NOT EXISTS soul_injector_plugin;");
    expect(fake.queries[2]).toBe("COMMIT");
    expect(fake.released).toBe(true);
  });

  test("rolls back and releases the client when migration fails", async () => {
    const fake = fakePool(true);
    await expect(new SoulInjectorRepository(fake.pool).migrate()).rejects.toThrow("migration failed");
    expect(fake.queries).toEqual(["BEGIN", expect.stringContaining("CREATE SCHEMA"), "ROLLBACK"]);
    expect(fake.released).toBe(true);
  });
});

describe("SoulInjector observation scope", () => {
  test("requires device observations to belong to the session device", async () => {
    const client = {
      query: async (query: string, params?: unknown[]) => {
        if (query.includes("SELECT s.id FROM")) {
          return {
            rows: params?.[2] === "device-1" ? [{ id: "session-1" }] : [],
            rowCount: params?.[2] === "device-1" ? 1 : 0,
          };
        }
        if (query.includes("INSERT INTO soul_injector_plugin.debug_observations")) {
          return {
            rows: [{
              id: "observation-1",
              session_id: "session-1",
              event_ref: "event-1",
              source: "device",
              kind: "debug.status",
              structured_data: { state: "running" },
              artifact_id: null,
              created_at: new Date(0),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ connect: async () => client } as unknown as Pool);
    await expect(repository.appendDebugObservation({
      projectId: "project-1",
      sessionId: "session-1",
      soulcloudDeviceRef: "device-1",
      eventRef: "event-1",
      source: "device",
      kind: "debug.status",
      structuredData: { state: "running" },
    })).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(repository.appendDebugObservation({
      projectId: "project-1",
      sessionId: "session-1",
      soulcloudDeviceRef: "device-2",
      eventRef: "event-2",
      source: "device",
      kind: "debug.status",
      structuredData: { state: "running" },
    })).rejects.toThrow("debug session is not available to this project");
  });
});

describe("SoulInjector debug session idempotency", () => {
  const input = {
    projectId: "00000000-0000-4000-8000-000000000001",
    caseId: "00000000-0000-4000-8000-000000000002",
    soulcloudDeviceRef: "00000000-0000-4000-8000-000000000003",
    executionRef: "00000000-0000-4000-8000-000000000004",
    pluginVersion: "0.1.0",
    manifestHash: "A".repeat(64),
    deviceFirmwareVersion: "firmware-1",
    startedBy: "00000000-0000-4000-8000-000000000005",
  };
  const existing = {
    id: "00000000-0000-4000-8000-000000000006",
    case_id: input.caseId,
    soulcloud_device_ref: input.soulcloudDeviceRef,
    execution_ref: input.executionRef,
    state: "active",
    plugin_version: input.pluginVersion,
    manifest_hash: input.manifestHash.toLowerCase(),
    device_firmware_version: input.deviceFirmwareVersion,
    started_by: input.startedBy,
    controller: null,
    started_at: new Date(0),
    ended_at: null,
  };

  function repositoryForExistingSession(row: Record<string, unknown>) {
    const queries: string[] = [];
    const client = {
      query: async (query: string) => {
        queries.push(query);
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (query.includes("SELECT id FROM soul_injector_plugin.debug_cases")) return { rows: [{ id: input.caseId }], rowCount: 1 };
        if (query.includes("INSERT INTO soul_injector_plugin.debug_sessions")) return { rows: [], rowCount: 0 };
        if (query.includes("SELECT s.* FROM soul_injector_plugin.debug_sessions")) return { rows: [row], rowCount: 1 };
        throw new Error(`unexpected query: ${query}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    return { repository: new SoulInjectorRepository({ connect: async () => client } as unknown as Pool), queries };
  }

  test("reuses an existing session for a retried execution", async () => {
    const fake = repositoryForExistingSession(existing);
    const result = await fake.repository.createDebugSession(input);
    expect(result.id).toBe(existing.id);
    expect(result.manifestHash).toBe(input.manifestHash.toLowerCase());
    expect(fake.queries).toContain("COMMIT");
  });

  test("rejects an execution retry with conflicting session metadata", async () => {
    const fake = repositoryForExistingSession({ ...existing, case_id: "00000000-0000-4000-8000-000000000099" });
    await expect(fake.repository.createDebugSession(input)).rejects.toBeInstanceOf(DebugSessionConflictError);
    expect(fake.queries).toContain("ROLLBACK");
  });
});

describe("SoulInjector device session state", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000016",
    case_id: "00000000-0000-4000-8000-000000000017",
    soulcloud_device_ref: "00000000-0000-4000-8000-000000000018",
    execution_ref: "00000000-0000-4000-8000-000000000019",
    state: "active",
    plugin_version: "0.1.0",
    manifest_hash: "b".repeat(64),
    device_firmware_version: null,
    started_by: "00000000-0000-4000-8000-000000000020",
    controller: null,
    started_at: new Date(0),
    ended_at: null,
  };

  function repositoryForState(current: Record<string, unknown>, updated: Record<string, unknown> = current) {
    const queries: string[] = [];
    const client = {
      query: async (query: string) => {
        queries.push(query);
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (query.includes("SELECT s.* FROM soul_injector_plugin.debug_sessions")) return { rows: [current], rowCount: 1 };
        if (query.includes("UPDATE soul_injector_plugin.debug_sessions")) return { rows: [updated], rowCount: 1 };
        throw new Error(`unexpected query: ${query}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    return { repository: new SoulInjectorRepository({ connect: async () => client } as unknown as Pool), queries };
  }

  test("updates a session only when the event belongs to its device", async () => {
    const updated = { ...base, state: "completed", ended_at: new Date(1) };
    const fake = repositoryForState(base, updated);
    const result = await fake.repository.updateDebugSessionState({
      projectId: "00000000-0000-4000-8000-000000000021",
      sessionId: base.id,
      soulcloudDeviceRef: base.soulcloud_device_ref,
      state: "completed",
    });
    expect(result.state).toBe("completed");
    expect(fake.queries.some((query) => query.startsWith("UPDATE soul_injector_plugin.debug_sessions"))).toBe(true);
  });

  test("does not move a terminal session backwards", async () => {
    const terminal = { ...base, state: "failed", ended_at: new Date(1) };
    const fake = repositoryForState(terminal);
    const result = await fake.repository.updateDebugSessionState({
      projectId: "00000000-0000-4000-8000-000000000021",
      sessionId: base.id,
      soulcloudDeviceRef: base.soulcloud_device_ref,
      state: "active",
    });
    expect(result.state).toBe("failed");
    expect(fake.queries.some((query) => query.startsWith("UPDATE soul_injector_plugin.debug_sessions"))).toBe(false);
  });
});
