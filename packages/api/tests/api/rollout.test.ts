/**
 * HTTP-level tests for the rollout routes: create (auto/grouped), detail,
 * and lifecycle operations (pause/resume/abort/rollback) with membership
 * enforcement.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { prisma } from "@soulcloud/core";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);

const testElf = buildNoloadElf(["value=%d"], ["demo"], 32, true);

let projectId: string;
let releaseId: string;
let fromReleaseId: string;
let accessToken = "";
let outsiderToken = "";
let deviceIds: string[] = [];

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "rollout-api-test" } });
  const owner = await registerUser("roll-owner");
  await prisma.userProject.create({ data: { userId: owner.userId, projectId } });
  accessToken = owner.accessToken;
  const outsider = await registerUser("roll-outsider");
  outsiderToken = outsider.accessToken;

  const target = await prisma.firmwareRelease.create({
    data: {
      id: randomUUID(),
      projectId,
      binHash: "aa".repeat(32),
      binBytes: Buffer.from(new Uint8Array(8).fill(0xaa)),
      binSize: 8,
      version: "v2.0.0",
    },
  });
  releaseId = target.id;
  const from = await prisma.firmwareRelease.create({
    data: {
      id: randomUUID(),
      projectId,
      binHash: "bb".repeat(32),
      binBytes: Buffer.from(new Uint8Array(8).fill(0xbb)),
      binSize: 8,
      version: "v1.0.0",
    },
  });
  fromReleaseId = from.id;
  for (let i = 0; i < 4; i++) {
    const d = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `roll-api-${randomUUID().slice(0, 8)}`,
        assignedId: `assigned-roll-api-${i}`,
        passwordHash: "unused",
        projectId,
      },
    });
    deviceIds.push(d.id);
  }
  void testElf;
});

async function registerUser(prefix: string): Promise<{ userId: string; accessToken: string }> {
  const username = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await app.handle(
    new Request("http://localhost/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "test-password-123",
        email: `${username}@example.com`,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return { userId: body.user_id, accessToken: body.access_token };
}

function auth(token = accessToken): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

afterAll(async () => {
  await prisma.otaTarget.deleteMany({ where: { job: { projectId } } });
  await prisma.otaJob.deleteMany({ where: { projectId } });
  await prisma.otaRolloutPool.deleteMany({ where: { rollout: { projectId } } });
  await prisma.otaRolloutPhase.deleteMany({ where: { rollout: { projectId } } });
  await prisma.otaRollout.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.firmwareRelease.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("POST /v1/firmware-releases/:id/rollouts", () => {
  test("creates an auto rollout (201) with phase 1 active", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          strategy: "auto",
          device_ids: deviceIds,
          ratios: [0.5, 1.0],
          from_release_id: fromReleaseId,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      rollout_id: string;
      phases: Array<{ index: number; target_count: number; state: string }>;
      job_id: string | null;
    };
    expect(body.phases).toEqual([
      { index: 1, target_count: 2, state: "active" },
      { index: 2, target_count: 4, state: "pending" },
    ]);
    expect(body.job_id).not.toBeNull();
  });

  test("creates a grouped rollout (201)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          strategy: "grouped",
          phases: [{ device_ids: deviceIds.slice(0, 1) }, { device_ids: deviceIds.slice(1, 3) }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { rollout_id: string };
    expect(body.rollout_id).toBeTruthy();
  });

  test("validation failures map to 400/404", async () => {
    // bad ratios
    const badRatios = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ strategy: "auto", device_ids: deviceIds, ratios: [0.9, 0.5] }),
      }),
    );
    expect(badRatios.status).toBe(400);
    // overlapping groups
    const overlap = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          strategy: "grouped",
          phases: [
            { device_ids: deviceIds.slice(0, 2) },
            { device_ids: deviceIds.slice(1, 3) },
          ],
        }),
      }),
    );
    expect(overlap.status).toBe(400);
    // unknown release
    const missing = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${randomUUID()}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ strategy: "auto", device_ids: deviceIds }),
      }),
    );
    expect(missing.status).toBe(404);
    // non-member
    const denied = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(outsiderToken),
        body: JSON.stringify({ strategy: "auto", device_ids: deviceIds }),
      }),
    );
    expect(denied.status).toBe(403);
    // device from another project -> 404 (no existence oracle)
    const otherProject = randomUUID();
    await prisma.project.create({ data: { id: otherProject, name: "rollout-other" } });
    const crossDevice = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `roll-cross-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-cross",
        passwordHash: "unused",
        projectId: otherProject,
      },
    });
    try {
      const cross = await app.handle(
        new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({ strategy: "auto", device_ids: [crossDevice.id] }),
        }),
      );
      expect(cross.status).toBe(404);
    } finally {
      await prisma.device.delete({ where: { id: crossDevice.id } });
      await prisma.project.delete({ where: { id: otherProject } });
    }
  });
});

describe("rollout lifecycle endpoints", () => {
  let rolloutId: string;
  beforeAll(async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${releaseId}/rollouts`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ strategy: "auto", device_ids: deviceIds, ratios: [1.0] }),
      }),
    );
    const body = (await res.json()) as { rollout_id: string };
    rolloutId = body.rollout_id;
  });

  test("detail shows state, phases and settings", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}`, { headers: auth() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rollout_id: string;
      state: string;
      strategy: string;
      success_ratio: number;
      phases: Array<{ index: number; state: string; summary: Record<string, number> | null }>;
      pool_size: number;
    };
    expect(body.rollout_id).toBe(rolloutId);
    expect(body.state).toBe("running");
    expect(body.strategy).toBe("auto");
    expect(body.success_ratio).toBe(0.9);
    expect(body.pool_size).toBe(4);
    expect(body.phases[0]).toMatchObject({ index: 1, state: "active" });
    expect(body.phases[0]?.summary).not.toBeNull();
  });

  test("pause / resume / abort with wrong-state 409s", async () => {
    const pause = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/pause`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(pause.status).toBe(200);
    const pausedAgain = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/pause`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(pausedAgain.status).toBe(409);
    const resume = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/resume`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(resume.status).toBe(200);
    const abort = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/abort`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(abort.status).toBe(200);
    const resumeAborted = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/resume`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(resumeAborted.status).toBe(409);
  });

  test("lifecycle operations enforce membership and existence", async () => {
    const denied = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/abort`, {
        method: "POST",
        headers: auth(outsiderToken),
      }),
    );
    expect(denied.status).toBe(404); // no existence oracle
    const missing = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${randomUUID()}/abort`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(missing.status).toBe(404);
    const detail = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}`, {
        headers: auth(outsiderToken),
      }),
    );
    expect(detail.status).toBe(403);
  });

  test("rollback without from_release_id -> 409 rollback_unavailable", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/ota-rollouts/${rolloutId}/rollback`, {
        method: "POST",
        headers: auth(),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rollback_unavailable" });
  });
});
