/**
 * Password hashing for human users and devices, unified on argon2id via
 * Bun.password (zero dependency, constant-time verification).
 *
 * Verification accepts argon2id only; legacy scrypt / plaintext hashes are
 * NOT accepted (they were only ever development data).
 *
 * Never throws on malformed stored values (returns false).
 */

import { randomBytes } from "node:crypto";

/** Hashes a password with argon2id (Bun.password). */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Backward-compatible alias for device credential code. */
export const hashDevicePassword = hashPassword;

/**
 * Verifies a password against a stored argon2id hash.
 *
 * @returns false for unknown formats (never throws on malformed input).
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;
  if (!stored.startsWith("$argon2id$")) return false;
  try {
    return await Bun.password.verify(password, stored);
  } catch {
    return false;
  }
}

/** Backward-compatible alias for device credential verification. */
export const verifyDevicePassword = verifyPassword;

/** Generates a strong random device credential password (base64url, 24 bytes). */
export function generateDevicePassword(): string {
  return randomBytes(24).toString("base64url");
}
