/**
 * Device password hashing (scrypt) with constant-time verification.
 *
 * Storage format: `scrypt$N$r$p$salt_b64$hash_b64`
 *
 * Legacy plaintext hashes are still accepted for verification (development
 * data) but never written; new hashes always use scrypt. A real device
 * credential management API (planned) will write scrypt hashes.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384; // 2^14
const R = 8;
const P = 1;
const KEY_LEN = 32;
const PREFIX = "scrypt";

/** Hashes a device password with scrypt. */
export async function hashDevicePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return `${PREFIX}$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Supports the scrypt format and (for legacy development data) plaintext.
 *
 * @returns false for unknown formats (never throws on malformed input).
 */
export async function verifyDevicePassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;

  if (stored.startsWith(`${PREFIX}$`)) {
    const parts = stored.split("$");
    if (parts.length !== 6) return false;
    // format: scrypt$N$r$p$salt_b64$hash_b64 (6 segments)
    const nStr = parts[1];
    const rStr = parts[2];
    const pStr = parts[3];
    const saltB64 = parts[4];
    const hashB64 = parts[5];
    if (nStr === undefined || rStr === undefined || pStr === undefined || saltB64 === undefined || hashB64 === undefined) {
      return false;
    }
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
      return false;
    }
    // scrypt requires N to be a power of two (and > 1); a tampered stored
    // hash must never make scrypt throw (docstring: "never throws")
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
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(actual, expected);
  }

  // legacy plaintext (development only; never written going forward)
  return stored === password;
}
