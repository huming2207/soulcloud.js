/**
 * Prisma client singleton plus re-exports of the generated Prisma types.
 *
 * All imports of the generated client (`generated/prisma/client`) must go
 * through this module so the generated path is referenced in exactly one
 * place (keeps tooling resolution robust and review simple).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  Prisma as PrismaNamespace,
} from "../generated/prisma/client";

export { PrismaNamespace as Prisma };
export type { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

/**
 * Creates an independent Prisma client for an explicit connection string
 * (used by tooling: the test-database preparation script connects to the
 * maintenance database and to the test database, neither of which is the
 * process-default DATABASE_URL).
 */
export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

export async function ping(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
