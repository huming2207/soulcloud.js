// Prisma CLI configuration.
// Loads .env from the package directory first, then the repo root
// (migrate/generate may run from either location; the package-local file
// wins when both exist).
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
