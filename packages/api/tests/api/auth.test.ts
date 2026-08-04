import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
