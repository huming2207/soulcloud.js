/**
 * Access-token payload validation (round-5 audit follow-up, P2).
 *
 * The malformed-payload branch lives in verifyAccessToken
 * (packages/core/src/auth/tokens.ts): after jose's signature/audience/exp
 * checks pass, the payload MUST be an object carrying string `sub` and
 * `username`. Every malformed variant must surface as a typed AuthError
 * (invalid_token / token_expired) — never as a raw 500 or an untyped
 * exception.
 *
 * Note: refresh tokens are opaque 256-bit random values (only the SHA-256
 * is stored), so the refresh path never parses a JWT payload — malformed
 * refresh inputs are rejected as unknown tokens (covered by
 * packages/api/tests/api/auth.test.ts). The payload-type defence tested
 * here is the access-token verify path.
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ACCESS_TOKEN_AUDIENCE,
  AuthError,
  signAccessToken,
  verifyAccessToken,
  type JwtConfig,
} from "@soulcloud/core";

const CONFIG: JwtConfig = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

function base64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

/**
 * Hand-signs a JWT with an arbitrary payload segment (bypasses jose's
 * encoder so we can ship payloads that are not a JSON object).
 */
function craftJwt(payloadSegment: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(payloadSegment);
  const sig = createHmac("sha256", CONFIG.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

/** A valid JWT whose claims object contains the given extras. */
function validClaims(extra: Record<string, unknown>): string {
  return craftJwt(
    JSON.stringify({
      aud: ACCESS_TOKEN_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...extra,
    }),
  );
}

/** A validly-signed JWT carrying EXACTLY the given claims (no defaults). */
function signedClaims(claims: Record<string, unknown>): string {
  return craftJwt(JSON.stringify(claims));
}

async function capture(
  promise: Promise<unknown>,
): Promise<{ error: AuthError | null; value: unknown }> {
  try {
    return { error: null, value: await promise };
  } catch (error) {
    return { error: error as AuthError, value: null };
  }
}

describe("verifyAccessToken malformed-payload handling", () => {
  test("accepts a well-formed payload", async () => {
    const token = await signAccessToken(CONFIG, { sub: "user-1", username: "alice" });
    await expect(verifyAccessToken(CONFIG, token)).resolves.toEqual({
      sub: "user-1",
      username: "alice",
    });
  });

  test("rejects a payload that is not JSON (typed rejection, not a 500)", async () => {
    const { error } = await capture(verifyAccessToken(CONFIG, craftJwt("this is not json")));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("invalid_token");
  });

  test("rejects payloads that are not JSON objects (empty/array/null/number)", async () => {
    for (const payload of ["", "null", "[]", "[1,2,3]", "42", '"a string"']) {
      const { error } = await capture(verifyAccessToken(CONFIG, craftJwt(payload)));
      expect(error, `payload segment ${JSON.stringify(payload)}`).toBeInstanceOf(AuthError);
      expect(error!.kind, `payload segment ${JSON.stringify(payload)}`).toBe("invalid_token");
    }
  });

  test("rejects a JSON object missing required fields", async () => {
    const cases: Record<string, unknown>[] = [
      { sub: "user-1" }, // no username
      { username: "alice" }, // no sub
      {}, // neither
    ];
    for (const claims of cases) {
      const { error } = await capture(verifyAccessToken(CONFIG, validClaims(claims)));
      expect(error, `claims ${JSON.stringify(claims)}`).toBeInstanceOf(AuthError);
      expect(error!.kind, `claims ${JSON.stringify(claims)}`).toBe("invalid_token");
      expect(error!.message).toBe("malformed token payload");
    }
  });

  test("rejects wrong-typed fields", async () => {
    const cases: Record<string, unknown>[] = [
      { sub: 123, username: "alice" },
      { sub: "user-1", username: 42 },
      { sub: ["user-1"], username: "alice" },
      { sub: "user-1", username: { nested: true } },
      { sub: null, username: "alice" },
      { sub: "user-1", username: null },
    ];
    for (const claims of cases) {
      const { error } = await capture(verifyAccessToken(CONFIG, validClaims(claims)));
      expect(error, `claims ${JSON.stringify(claims)}`).toBeInstanceOf(AuthError);
      expect(error!.kind, `claims ${JSON.stringify(claims)}`).toBe("invalid_token");
      expect(error!.message).toBe("malformed token payload");
    }
  });

  test("expired tokens surface as token_expired (typed, not a 500)", async () => {
    const expired = validClaims({
      sub: "user-1",
      username: "alice",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const { error } = await capture(verifyAccessToken(CONFIG, expired));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("token_expired");
  });

  test("rejects tokens without an aud claim (fast-jwt would skip allowedAud)", async () => {
    const noAud = signedClaims({
      sub: "user-1",
      username: "alice",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const { error } = await capture(verifyAccessToken(CONFIG, noAud));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("invalid_token");
  });

  test("rejects tokens without an exp claim (a WS session would never expire)", async () => {
    const noExp = signedClaims({
      sub: "user-1",
      username: "alice",
      aud: ACCESS_TOKEN_AUDIENCE,
    });
    const { error } = await capture(verifyAccessToken(CONFIG, noExp));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("invalid_token");
  });

  test("rejects the ota-download audience (no token-class confusion)", async () => {
    const wrongAud = signedClaims({
      sub: "user-1",
      username: "alice",
      aud: "ota-download",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const { error } = await capture(verifyAccessToken(CONFIG, wrongAud));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("invalid_token");
  });

  test("garbage/truncated/tampered tokens are rejected as invalid_token", async () => {
    for (const token of ["not-a-jwt", "a.b", "a.b.c"]) {
      const { error } = await capture(verifyAccessToken(CONFIG, token));
      expect(error).toBeInstanceOf(AuthError);
      expect(error!.kind).toBe("invalid_token");
    }
    const good = await signAccessToken(CONFIG, { sub: "user-1", username: "alice" });
    const tampered = `${good.slice(0, -3)}zzz`;
    const { error } = await capture(verifyAccessToken(CONFIG, tampered));
    expect(error).toBeInstanceOf(AuthError);
    expect(error!.kind).toBe("invalid_token");
  });
});
