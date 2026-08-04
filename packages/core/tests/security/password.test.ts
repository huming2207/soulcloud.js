import { describe, expect, test } from "bun:test";
import {
  generateDevicePassword,
  hashPassword,
  hashDevicePassword,
  verifyDevicePassword,
  verifyPassword,
} from "../../src/security/password";

describe("password hashing (argon2id)", () => {
  test("argon2id hash round-trips", async () => {
    const hash = await hashDevicePassword("secret-password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyDevicePassword("secret-password", hash)).toBe(true);
    expect(await verifyDevicePassword("wrong", hash)).toBe(false);
  });

  test("hashPassword and verifyPassword work for human users", async () => {
    const hash = await hashPassword("user-password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("user-password", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("two hashes of the same password differ (random salt)", async () => {
    const a = await hashDevicePassword("same");
    const b = await hashDevicePassword("same");
    expect(a).not.toBe(b);
    expect(await verifyDevicePassword("same", a)).toBe(true);
    expect(await verifyDevicePassword("same", b)).toBe(true);
  });

  test("rejects malformed scrypt hashes", async () => {
    expect(await verifyDevicePassword("x", "scrypt$bad")).toBe(false);
    expect(await verifyDevicePassword("x", "scrypt$1$2$3$4")).toBe(false);
    expect(await verifyDevicePassword("x", "scrypt$0$8$1$c2FsdA==$aGVsbG8=")).toBe(false); // N=0
    expect(await verifyDevicePassword("x", "")).toBe(false);
    expect(await verifyDevicePassword("x", "not-a-hash")).toBe(false);
  });

  test("accepts legacy plaintext hashes (development data)", async () => {
    expect(await verifyDevicePassword("plain", "plain")).toBe(true);
    expect(await verifyDevicePassword("wrong", "plain")).toBe(false);
  });

  test("still verifies legacy scrypt hashes", async () => {
    // a scrypt hash produced by the previous format
    const legacy = "scrypt$16384$8$1$LOsnxOhc1rl1+tUZZ4A4tA==$9HKjVYVzLwQcP0pV5d/3EqzG5K7aHsVt4h8UFAJqYFY=";
    // verification against this exact blob must not throw; wrong password false
    expect(await verifyDevicePassword("anything", legacy)).toBe(false);
    // and a freshly computed scrypt hash still verifies
    const { randomBytes, scrypt: scryptCb } = await import("node:crypto");
    const { promisify } = await import("node:util");
    const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: { N: number; r: number; p: number }) => Promise<Buffer>;
    const salt = randomBytes(16);
    const hash = await scrypt("pw", salt, 32, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
    expect(await verifyDevicePassword("pw", stored)).toBe(true);
  });

  test("generateDevicePassword returns a strong random value", () => {
    const a = generateDevicePassword();
    const b = generateDevicePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
