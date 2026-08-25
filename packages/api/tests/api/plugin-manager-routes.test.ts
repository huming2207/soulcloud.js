import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma } from "@soulcloud/core";
import { createApp } from "../../src/api/app";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const SERVICE_TOKEN = "test-service-token-0123456789";

let manager: { url: URL; stop(): Promise<void> };
let receivedBindingRequests: unknown[] = [];
let receivedTargetConfigListRequests: unknown[] = [];
let projectId: string;
let installationId: string;
let deviceId: string;
let accessToken = "";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  // Fake Plugin Manager internal endpoint: record the bind body so the test
  // can prove Human API mapped its snake_case public contract to the
  // Manager's camelCase internal contract.
  manager = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/bindings")) {
        receivedBindingRequests.push(await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/target-configs")) {
        receivedTargetConfigListRequests.push(await request.json());
        return new Response(JSON.stringify([{ configId: randomUUID(), revision: 2, sha256: "b".repeat(64), targetCount: 1, createdAt: new Date(0).toISOString() }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  app = createApp(
    prisma,
    TEST_JWT,
    900,
    {},
    1024 * 1024,
    {},
    {
      internalUrl: manager.url.toString(),
      serviceToken: SERVICE_TOKEN,
      requestTimeoutMs: 5_000,
    },
  );

  const register = await app.handle(
    new Request("http://localhost/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: `plugin-route-${randomUUID().slice(0, 8)}`,
        password: "test-password-123",
        email: `plugin-route-${randomUUID().slice(0, 8)}@example.com`,
      }),
    }),
  );
  expect(register.status).toBe(201);
  const registered = (await register.json()) as { user_id: string; access_token: string };
  accessToken = registered.access_token;

  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "plugin-route-test-project" } });
  await prisma.userProject.create({ data: { userId: registered.user_id, projectId } });
  installationId = randomUUID();
  await prisma.pluginInstallation.create({
    data: {
      id: installationId,
      projectId,
      pluginId: "test.plugin",
      pluginVersion: "1.0.0",
      manifestHash: "a".repeat(64),
      state: "enabled",
      config: {},
    },
  });
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: `plugin-route-dev-${randomUUID().slice(0, 8)}`,
      assignedId: `assigned-${randomUUID().slice(0, 8)}`,
      passwordHash: "unused-hash",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.userProject.deleteMany({ where: { projectId } });
  await prisma.pluginInstallation.deleteMany({ where: { id: installationId } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await manager.stop();
  await prisma.$disconnect();
});

describe("POST /v1/plugin-installations/:id/bindings", () => {
  test("maps the public snake_case body to the Manager camelCase contract", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/plugin-installations/${installationId}/bindings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          device_id: deviceId,
          profile_id: "profile-a",
          profile_version: 1,
        }),
      }),
    );

    expect(res.status).toBe(204);
    expect(receivedBindingRequests).toEqual([{
      deviceId,
      profileId: "profile-a",
      profileVersion: 1,
    }]);
  });

  test("rejects a malformed body without forwarding it to the Manager", async () => {
    const forwarded = receivedBindingRequests.length;
    const res = await app.handle(
      new Request(`http://localhost/v1/plugin-installations/${installationId}/bindings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ device_id: "not-a-uuid" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(receivedBindingRequests).toHaveLength(forwarded);
  });
});

describe("GET /v1/plugin-installations/:id/debugger/target-configs", () => {
  test("forwards the authenticated project scope and returns revision metadata", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/plugin-installations/${installationId}/debugger/target-configs`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(receivedTargetConfigListRequests).toEqual([{ installationId, projectId, userId: expect.any(String), timeoutMs: 4_000 }]);
  });
});
