import { describe, expect, test } from "bun:test";
import type { Pool, PoolClient } from "pg";
import { SoulInjectorRepository } from "../src/repository";

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
