/**
 * authenticateDevice unit tests with a mock prisma (Kimi round-7 P1-7):
 * the DB-failure path is untestable through a live broker, and it is the
 * behavior that keeps misbehaving devices from giving up (returnCode 3 =
 * server unavailable, clients keep retrying).
 */
import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@soulcloud/core";
import { authenticateDevice } from "../../src/mqtt/broker";

function mockPrisma(device: unknown): PrismaClient {
  return {
    device: {
      findUnique: async () => device,
    },
  } as unknown as PrismaClient;
}

describe("authenticateDevice", () => {
  test("accepts a valid argon2id password", async () => {
    const hash = await Bun.password.hash("device-secret", "argon2id");
    const prisma = mockPrisma({ passwordHash: hash, authRevoked: false });
    expect(await authenticateDevice(prisma, "uid-1", Buffer.from("device-secret"))).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const hash = await Bun.password.hash("device-secret", "argon2id");
    const prisma = mockPrisma({ passwordHash: hash, authRevoked: false });
    expect(await authenticateDevice(prisma, "uid-1", Buffer.from("nope"))).toBe(false);
  });

  test("rejects revoked credentials", async () => {
    const hash = await Bun.password.hash("device-secret", "argon2id");
    const prisma = mockPrisma({ passwordHash: hash, authRevoked: true });
    expect(await authenticateDevice(prisma, "uid-1", Buffer.from("device-secret"))).toBe(false);
  });

  test("rejects unknown devices and missing passwords", async () => {
    expect(await authenticateDevice(mockPrisma(null), "uid-1", Buffer.from("x"))).toBe(false);
    expect(await authenticateDevice(mockPrisma({ passwordHash: "x" }), "uid-1", undefined)).toBe(
      false,
    );
  });

  test("propagates database failures (broker maps them to returnCode 3)", async () => {
    const prisma = {
      device: {
        findUnique: async () => {
          throw new Error("connection refused");
        },
      },
    } as unknown as PrismaClient;
    await expect(authenticateDevice(prisma, "uid-1", Buffer.from("x"))).rejects.toThrow(
      "connection refused",
    );
  });
});
