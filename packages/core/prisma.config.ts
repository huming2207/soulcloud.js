// Prisma CLI configuration.
// Loads .env from the repo root or the package directory, whichever exists
// (migrate/generate may run from either location).
import { existsSync } from "node:fs";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

for (const path of [".env", "../../.env"]) {
  if (existsSync(path)) {
    config({ path });
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
