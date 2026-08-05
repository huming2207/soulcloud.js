import type { PrismaClient } from "../../src/db";
const LEASE_LOCK_KEY = 0x5a4f554c;
export async function acquireLeaseLock(prisma: PrismaClient): Promise<void> {
  console.log(`[${process.pid}] acquiring lease lock...`);
  const t0 = Date.now();
  await prisma.$executeRaw`SELECT pg_advisory_lock(${LEASE_LOCK_KEY})`;
  console.log(`[${process.pid}] acquired after ${Date.now() - t0}ms`);
}
export async function releaseLeaseLock(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_unlock(${LEASE_LOCK_KEY})`;
}
