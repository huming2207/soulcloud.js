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
