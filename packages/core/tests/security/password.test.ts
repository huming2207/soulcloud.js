import { describe, expect, test } from "bun:test";
import {
  hashDevicePassword,
  verifyDevicePassword,
} from "../../src/security/password";

describe("device password hashing", () => {
  test("scrypt hash round-trips", async () => {
    const hash = await hashDevicePassword("secret-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyDevicePassword("secret-password", hash)).toBe(true);
    expect(await verifyDevicePassword("wrong", hash)).toBe(false);
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
});
