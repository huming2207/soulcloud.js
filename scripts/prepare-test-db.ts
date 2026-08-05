/**
 * Prepares the isolated test database for the test suite:
 *
 *   1. creates the database when missing (idempotent, via the admin
 *      connection to the `postgres` maintenance database)
 *   2. applies migrations (prisma migrate deploy against the test URL)
 *   3. truncates every table (clean start for this run)
 *
 * The suite must NEVER run against the dev database: the dev MQTT broker
 * polls the global command queue every ~500ms and steals rows from
 * concurrently running tests (attempt_count inflation, lease races).
 * Keeping the tests on their own database lets the dev broker and QEMU
 * firmware E2E keep running while the suite executes.
 */

import { spawnSync } from "node:child_process";
import { createPrisma } from "@soulcloud/core";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://soulcloud:soulcloud@127.0.0.1:5432/soulcloud_test";

const url = new URL(TEST_DATABASE_URL);
const dbName = url.pathname.replace(/^\//, "") || "soulcloud_test";

/** Same credentials, but pointing at the `postgres` maintenance database. */
function adminUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = "/postgres";
  return u.toString();
}

async function ensureDatabase(): Promise<void> {
  const admin = createPrisma(adminUrl());
  try {
    const rows = await admin.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_database WHERE datname = ${dbName}
    `;
    if ((rows[0]?.count ?? 0) === 0) {
      // CREATE DATABASE cannot run inside a transaction or be parameterised
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`[test-db] created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }
}

function migrate(): void {
  const result = spawnSync(
    "bun",
    ["run", "--cwd", "packages/core", "db:deploy"],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    console.error(`[test-db] migrate deploy failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

async function truncateAll(): Promise<void> {
  const client = createPrisma(TEST_DATABASE_URL);
  try {
    // keep _prisma_migrations: it must reflect the applied migrations or
    // `migrate deploy` would replay them against existing tables
    await client.$executeRawUnsafe(`
      DO $$ DECLARE r RECORD; BEGIN
        FOR r IN (SELECT tablename FROM pg_tables
                  WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') LOOP
          EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
        END LOOP;
      END $$;
    `);
  } finally {
    await client.$disconnect();
  }
}

console.log(`[test-db] target: ${TEST_DATABASE_URL}`);
await ensureDatabase();
migrate();
await truncateAll();
console.log("[test-db] ready");
