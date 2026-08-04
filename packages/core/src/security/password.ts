/**
 * Password hashing for human users and devices, unified on argon2id via
 * Bun.password (zero dependency, constant-time verification).
 *
 * Verification is backward compatible:
 *   1. argon2id (`$argon2id$...`) - current standard (Bun.password)
 *   2. scrypt (`scrypt$N$r$p$salt$hash`) - previous device format, still
 *      accepted for existing devices; hashes re-written on next credential
 *      update
 *   3. plaintext - legacy development data only; never written
 *
 * Never throws on malformed stored values (returns false).
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;
const SCRYPT_PREFIX = "scrypt";

/** Hashes a password with argon2id (Bun.password). */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Backward-compatible alias for device credential code. */
export const hashDevicePassword = hashPassword;

/**
 * Verifies a password against a stored hash.
 *
 * Supports argon2id, the legacy scrypt format and (for legacy development
 * data) plaintext.
 *
 * @returns false for unknown formats (never throws on malformed input).
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;

  // argon2id (Bun.password) - current standard
  if (stored.startsWith("$argon2id$")) {
    try {
      return await Bun.password.verify(password, stored);
    } catch {
      return false;
    }
  }

  // legacy scrypt device format
  if (stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    return verifyScrypt(password, stored);
  }

  // legacy plaintext (development only; never written going forward)
  return stored === password;
}

/** Backward-compatible alias for device credential verification. */
export const verifyDevicePassword = verifyPassword;

/** Verifies a legacy scrypt hash; never throws. */
async function verifyScrypt(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  // format: scrypt$N$r$p$salt_b64$hash_b64 (6 segments)
  const nStr = parts[1];
  const rStr = parts[2];
  const pStr = parts[3];
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (
    nStr === undefined ||
    rStr === undefined ||
    pStr === undefined ||
    saltB64 === undefined ||
    hashB64 === undefined
  ) {
    return false;
  }
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0
  ) {
    return false;
  }
  // scrypt requires N to be a power of two (and > 1); a tampered stored
  // hash must never make scrypt throw
  if ((n & (n - 1)) !== 0 || n <= 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length, {
    N: n,
    r,
    p,
  });
  return timingSafeEqual(actual, expected);
}

/** Generates a strong random device credential password (base64url, 24 bytes). */
export function generateDevicePassword(): string {
  return randomBytes(24).toString("base64url");
}
