/**
 * db.ts tests: the createPrisma factory returns an independent client.
 * Runs against the same test database as the rest of the suite.
 */
import { describe, expect, test } from "bun:test";
import { createPrisma, prisma, ping } from "../src/db";

describe("createPrisma", () => {
  test("creates an independent client that can ping the database", async () => {
    const url = process.env.DATABASE_URL!;
    expect(url).toBeTruthy();
    const client = createPrisma(url);
    try {
      const rows = await client.$queryRaw<{ n: number }[]>`SELECT 1 AS n`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await client.$disconnect();
    }
  });

  test("the shared prisma singleton still pings", async () => {
    expect(await ping()).toBe(true);
    await prisma.$queryRaw`SELECT 1`;
  });
});
