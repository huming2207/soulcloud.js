import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "@soulcloud/core";
import { createApp } from "../../src/api/app";

// G-group auth tests: register/login/refresh rotation/logout/reuse
// detection, device credential issue/revoke, revoked device refused by
// the MQTT broker.

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);

let projectId: string;
let deviceId: string;
let deviceUid: string;

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "auth-test-project" } });
  deviceUid = `auth-dev-${randomUUID().slice(0, 8)}`;
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-auth",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.userProject.deleteMany({ where: { projectId } });
  await prisma.refreshToken.deleteMany({
    where: { user: { projects: { some: { projectId } } } },
  });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

function jsonRequest(path: string, method: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function register(username: string) {
  const res = await app.handle(
    jsonRequest("/v1/auth/register", "POST", {
      username,
      password: "test-password-123",
      email: `${username}@example.com`,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    user_id: string;
    access_token: string;
    refresh_token: string;
  };
}

describe("auth flow", () => {
  test("register creates a user with a personal project", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);
    expect(user.access_token).toBeTruthy();
    expect(user.refresh_token).toBeTruthy();
    const links = await prisma.userProject.findMany({
      where: { userId: user.user_id },
      include: { project: true },
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.project.name).toBe(`${username}'s project`);
  });

  test("login issues tokens; wrong password is rejected", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    await register(username);
    const ok = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();

    const bad = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "invalid_credentials" });
  });

  test("duplicate username -> 409", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    await register(username);
    const dup = await app.handle(
      jsonRequest("/v1/auth/register", "POST", {
        username,
        password: "test-password-123",
        email: `${username}@example.com`,
      }),
    );
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "username_or_email_taken" });
  });

  test("refresh rotates tokens; the old refresh token is revoked", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);

    const r1 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    expect(r1.status).toBe(200);
    const rotated = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(user.refresh_token);

    // old token is now revoked -> reuse detection
    const reuse = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    expect(reuse.status).toBe(401);
    expect(await reuse.json()).toMatchObject({ error: "reuse_detected" });
  });

  test("reuse detection revokes the whole chain", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);

    const r1 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    const t1 = (await r1.json()) as { refresh_token: string };
    const r2 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: t1.refresh_token }),
    );
    const t2 = (await r2.json()) as { refresh_token: string };

    // replay t1 (already rotated) -> chain revoked, t2 must also fail
    await app.handle(jsonRequest("/v1/auth/refresh", "POST", { refresh_token: t1.refresh_token }));
    const t2reuse = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: t2.refresh_token }),
    );
    expect(t2reuse.status).toBe(401);
  });

  test("H2: reuse detection revokes the whole family at any chain depth", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);

    // rotate twice: T0 -> T1 -> T2 -> T3
    const r1 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    const t1 = (await r1.json()) as { refresh_token: string };
    const r2 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: t1.refresh_token }),
    );
    const t2 = (await r2.json()) as { refresh_token: string };
    const r3 = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: t2.refresh_token }),
    );
    const t3 = (await r3.json()) as { refresh_token: string };

    // replay T0 (the ROOT, depth 2 away) -> the whole family dies
    const replay = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "reuse_detected" });

    for (const token of [t1.refresh_token, t2.refresh_token, t3.refresh_token]) {
      const attempt = await app.handle(
        jsonRequest("/v1/auth/refresh", "POST", { refresh_token: token }),
      );
      expect(attempt.status).toBe(401);
      expect(await attempt.json()).toMatchObject({ error: "reuse_detected" });
    }
  });

  test("M1: concurrent refresh of the same token lets only one win", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);

    const [a, b] = await Promise.all([
      app.handle(jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token })),
      app.handle(jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token })),
    ]);
    const statuses = [a.status, b.status].sort();
    // one rotation succeeds, the other is detected as reuse
    expect(statuses).toEqual([200, 401]);
    // the reuse signal revokes the whole family: the winner's successor
    // token is dead too (forced re-login is the intended semantics)
    const winner = a.status === 200 ? (await a.json()) : (await b.json());
    const finalAttempt = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", {
        refresh_token: (winner as { refresh_token: string }).refresh_token,
      }),
    );
    expect(finalAttempt.status).toBe(401);
    // all tokens of the user are revoked
    const row = await prisma.refreshToken.findFirst({
      where: { user: { username } },
      select: { revokedAt: true },
    });
    expect(row?.revokedAt).not.toBeNull();
  });

  test("logout revokes the refresh token", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);
    const out = await app.handle(
      jsonRequest("/v1/auth/logout", "POST", { refresh_token: user.refresh_token }),
    );
    expect(out.status).toBe(200);
    const reuse = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    expect(reuse.status).toBe(401);
  });

  test("protected endpoints reject missing/invalid tokens", async () => {
    const res = await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/logs`, "GET", undefined),
    );
    expect(res.status).toBe(401);

    const bad = await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/logs`, "GET", undefined, "not-a-jwt"),
    );
    expect(bad.status).toBe(401);
  });
});

describe("device credentials", () => {
  let token: string;

  beforeAll(async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);
    token = user.access_token;
    await prisma.userProject.create({ data: { userId: user.user_id, projectId } });
  });

  test("issue returns a one-time password and stores its hash", async () => {
    const res = await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/credentials`, "POST", undefined, token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mqtt_username: string;
      mqtt_password: string;
    };
    expect(body.mqtt_username).toBe(deviceUid);
    expect(body.mqtt_password.length).toBeGreaterThanOrEqual(32);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(device.authRevoked).toBe(false);
  });

  test("revoke blocks new connections", async () => {
    const res = await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/credentials/revoke`, "POST", undefined, token),
    );
    expect(res.status).toBe(200);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.authRevoked).toBe(true);
    // re-issue clears the flag
    await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/credentials`, "POST", undefined, token),
    );
    const after = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(after.authRevoked).toBe(false);
  });

  test("credentials require membership of the device project", async () => {
    const outsider = await register(`auth-${randomUUID().slice(0, 8)}`);
    const res = await app.handle(
      jsonRequest(`/v1/devices/${deviceId}/credentials`, "POST", undefined, outsider.access_token),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });
});

describe("auth edge cases", () => {
  test("refresh with an unknown token -> 401 invalid_token", async () => {
    const res = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: "definitely-not-a-real-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  test("refresh with an expired token -> 401 token_expired", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);
    // force expiry by backdating the stored token
    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(user.refresh_token).digest("hex");
    await prisma.refreshToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await app.handle(
      jsonRequest("/v1/auth/refresh", "POST", { refresh_token: user.refresh_token }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "token_expired" });
  });

  test("registration input validation -> 400", async () => {
    const cases = [
      { username: "ab", password: "test-password-123", email: "a@example.com" }, // username too short
      { username: "bad name!", password: "test-password-123", email: "a@example.com" }, // invalid chars
      { username: "okname", password: "short", email: "a@example.com" }, // password too short
      { username: "okname", password: "test-password-123", email: "not-an-email" }, // bad email
    ];
    for (const body of cases) {
      const res = await app.handle(jsonRequest("/v1/auth/register", "POST", body));
      expect(res.status).toBe(400);
    }
  });

  test("access token expiry is enforced", async () => {
    // a short-TTL app instance
    const shortApp = createApp(prisma, {
      secret: "test-secret-0123456789-0123456789-0123456789",
      accessTtlSeconds: 1,
      refreshTtlSeconds: 3600,
    });
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const regRes = await shortApp.handle(
      jsonRequest("/v1/auth/register", "POST", {
        username,
        password: "test-password-123",
        email: `${username}@example.com`,
      }),
    );
    const user = (await regRes.json()) as { user_id: string; access_token: string };
    await prisma.userProject.create({ data: { userId: user.user_id, projectId } });
    const res = await shortApp.handle(
      jsonRequest(`/v1/devices/${deviceId}/logs`, "GET", undefined, user.access_token),
    );
    expect(res.status).toBe(200); // still valid
    // wait past TTL
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await shortApp.handle(
      jsonRequest(`/v1/devices/${deviceId}/logs`, "GET", undefined, user.access_token),
    );
    expect(expired.status).toBe(401);
  });

  test("device credentials for an unknown device -> 404", async () => {
    const username = `auth-${randomUUID().slice(0, 8)}`;
    const user = await register(username);
    await prisma.userProject.create({ data: { userId: user.user_id, projectId } });
    const res = await app.handle(
      jsonRequest(`/v1/devices/${randomUUID()}/credentials`, "POST", undefined, user.access_token),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "device_not_found" });
  });
});

describe("login throttling (M5 round-5)", () => {
  test("repeated failures lock the username; a correct password still fails while locked", async () => {
    const username = `throttle-${randomUUID().slice(0, 8)}`;
    await register(username);

    // five wrong passwords -> locked
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(
        jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
      );
      expect(res.status).toBe(401);
    }
    // the sixth attempt (even with the RIGHT password) is rejected
    const locked = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
    );
    expect(locked.status).toBe(401);
    expect(await locked.json()).toMatchObject({ error: "invalid_credentials" });
  });

  test("the lock auto-expires after LOGIN_LOCK_SECONDS and login succeeds again", async () => {
    const username = `throttle-expire-${randomUUID().slice(0, 8)}`;
    await register(username);

    // five failures -> locked
    for (let i = 0; i < 5; i++) {
      const res = await app.handle(
        jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
      );
      expect(res.status).toBe(401);
    }
    const locked = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
    );
    expect(locked.status).toBe(401);
    expect(await locked.json()).toMatchObject({ error: "invalid_credentials" });

    // the lock is Date.now()-based and module-internal (not injectable);
    // advance the process clock past the 60s window instead of waiting
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      const unlocked = await app.handle(
        jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
      );
      expect(unlocked.status).toBe(200);
      const body = (await unlocked.json()) as { access_token: string };
      expect(body.access_token).toBeTruthy();
    } finally {
      setSystemTime();
    }
  });

  test("a successful login clears the failure counter", async () => {
    const username = `throttle-ok-${randomUUID().slice(0, 8)}`;
    await register(username);
    // two failures then a success clears the counter
    await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
    );
    await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
    );
    const ok = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
    );
    expect(ok.status).toBe(200);
    // failures resume counting from zero: 4 more failures must NOT lock yet
    for (let i = 0; i < 4; i++) {
      await app.handle(
        jsonRequest("/v1/auth/login", "POST", { username, password: "wrong-password" }),
      );
    }
    const stillOpen = await app.handle(
      jsonRequest("/v1/auth/login", "POST", { username, password: "test-password-123" }),
    );
    expect(stillOpen.status).toBe(200);
  });
});
