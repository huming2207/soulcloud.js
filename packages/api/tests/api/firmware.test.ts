/**
 * HTTP-level tests for the OTA firmware release routes: upload (bin
 * required, ELF optional), idempotency, listing, detail, and single-use
 * temporary download URLs (no Bearer required at the consumption end).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { prisma, signOtaToken } from "@soulcloud/core";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT, 900);

const testElf = buildNoloadElf(["value=%d"], ["demo"], 32, true);

/** Deterministic fake bin image. */
function makeBin(size = 2048, seed = 7): Uint8Array {
  const bin = new Uint8Array(size);
  for (let i = 0; i < size; i++) bin[i] = (i * 31 + seed) & 0xff;
  return bin;
}

function binHash(bin: Uint8Array): string {
  return createHash("sha256").update(bin).digest("hex");
}

let projectId: string;
let otherProjectId: string;
let accessToken = "";
let otherAccessToken = "";
let deviceId = "";
let deviceUid = "";
let otherProjectDeviceId = "";

async function registerUser(prefix: string): Promise<{ userId: string; token: string }> {
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
  return { userId: body.user_id, token: body.access_token };
}

function authHeaders(token = accessToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function uploadForm(overrides: Record<string, unknown> = {}): FormData {
  const form = new FormData();
  form.append("project_id", String(overrides.project_id ?? projectId));
  if (overrides.version) form.append("version", String(overrides.version));
  if (overrides.bin !== undefined) {
    form.append("bin", new Blob([overrides.bin as Uint8Array]), "firmware.bin");
  }
  if (overrides.elf !== undefined) {
    form.append("elf", new Blob([overrides.elf as Uint8Array]), "firmware.elf");
  }
  return form;
}

let createdReleaseId = "";
let createdBinHash = "";

beforeAll(async () => {
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "ota-api-test" } });
  await prisma.project.create({ data: { id: otherProjectId, name: "ota-api-other" } });
  const owner = await registerUser("ota-owner");
  await prisma.userProject.create({ data: { userId: owner.userId, projectId } });
  accessToken = owner.token;
  const outsider = await registerUser("ota-outsider");
  otherAccessToken = outsider.token;
  deviceUid = `ota-api-${randomUUID().slice(0, 8)}`;
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-ota-api",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
  const cross = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid: `ota-api-x-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-ota-api-x",
      passwordHash: "unused",
      projectId: otherProjectId,
    },
  });
  otherProjectDeviceId = cross.id;
});

afterAll(async () => {
  await prisma.otaTarget.deleteMany({ where: { job: { projectId: { in: [projectId, otherProjectId] } } } });
  await prisma.otaJob.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
  await prisma.device.deleteMany({
    where: { id: { in: [deviceId, otherProjectDeviceId] } },
  });
  await prisma.firmwareRelease.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.firmwareArtifact.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.$disconnect();
});

describe("POST /v1/firmware-releases", () => {
  test("bin-only upload (201, no artifact)", async () => {
    const bin = makeBin();
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      release_id: string;
      bin_hash: string;
      bin_size: number;
      artifact_id: string | null;
    };
    expect(body.bin_hash).toBe(binHash(bin));
    expect(body.bin_size).toBe(bin.byteLength);
    expect(body.artifact_id).toBeNull();
  });

  test("elf+bin upload links the artifact (201)", async () => {
    const bin = makeBin(1024, 3);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin, elf: testElf, version: "v0.9.0" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      release_id: string;
      bin_hash: string;
      artifact_id: string | null;
      version: string | null;
    };
    expect(body.artifact_id).not.toBeNull();
    expect(body.version).toBe("v0.9.0");
    createdReleaseId = body.release_id;
    createdBinHash = body.bin_hash;
  });

  test("re-uploading the same bin is idempotent (200, same id)", async () => {
    const bin = makeBin(1024, 3);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { release_id: string; bin_hash: string };
    expect(body.release_id).toBe(createdReleaseId);
    expect(body.bin_hash).toBe(createdBinHash);
  });

  test("missing bin -> 422", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ elf: testElf }),
      }),
    );
    expect(res.status).toBe(422);
  });

  test("invalid ELF -> 422, no release row", async () => {
    const bin = makeBin(512, 11);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin, elf: new Uint8Array([1, 2, 3]) }),
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_elf" });
    const rows = await prisma.firmwareRelease.count({
      where: { projectId, binHash: binHash(bin) },
    });
    expect(rows).toBe(0);
  });

  test("bad project_id -> 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ project_id: "not-a-uuid", bin: makeBin(64) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown project -> 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ project_id: randomUUID(), bin: makeBin(64) }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("non-member -> 403", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(otherAccessToken),
        body: uploadForm({ bin: makeBin(64) }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("no auth -> 401", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: uploadForm({ bin: makeBin(64) }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("oversized bin -> 413 (declared content-length)", async () => {
    const big = new Uint8Array(32 * 1024 * 1024 + 1);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin: big }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("GET /v1/firmware-releases", () => {
  test("lists releases with pagination", async () => {
    // create a second release so pagination is exercisable
    const bin = makeBin(333, 5);
    await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin }),
      }),
    );
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases?project_id=${projectId}&limit=1`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ release_id: string; bin_hash: string }>;
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();
    // follow the cursor to the remaining page
    const res2 = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases?project_id=${projectId}&limit=10&cursor=${encodeURIComponent(body.next_cursor!)}`,
        { headers: authHeaders() },
      ),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body2.items.length).toBeGreaterThanOrEqual(1);
    expect(body2.next_cursor).toBeNull();
  });

  test("non-member -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases?project_id=${projectId}`, {
        headers: authHeaders(otherAccessToken),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("invalid cursor -> 400", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases?project_id=${projectId}&cursor=garbage`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/firmware-releases/:id", () => {
  test("detail includes artifact build id when linked", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      release_id: string;
      bin_hash: string;
      artifact: { build_id: string; dictionary_entries: number } | null;
    };
    expect(body.release_id).toBe(createdReleaseId);
    expect(body.bin_hash).toBe(createdBinHash);
    expect(body.artifact?.build_id).toBe(binHash(testElf));
    expect(body.artifact?.dictionary_entries).toBeGreaterThan(0);
  });

  test("unknown release -> 404", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${randomUUID()}`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("non-member -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}`, {
        headers: authHeaders(otherAccessToken),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/firmware-releases/:id/deploy", () => {
  test("deploys to online project devices (201)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      job_id: string;
      targets: Array<{ device_id: string; device_uid: string; state: string }>;
    };
    expect(body.job_id).toBeTruthy();
    expect(body.targets).toEqual([
      { device_id: deviceId, device_uid: deviceUid, state: "pending" },
    ]);
    const targets = await prisma.otaTarget.count({ where: { jobId: body.job_id } });
    expect(targets).toBe(1);
  });

  test("device from another project -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [otherProjectDeviceId] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  test("unknown device -> 404", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [randomUUID()] }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "target_devices_not_found" });
  });

  test("empty / duplicate device lists -> 400", async () => {
    const empty = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [] }),
      }),
    );
    expect(empty.status).toBe(400);
    const dup = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId, deviceId] }),
      }),
    );
    expect(dup.status).toBe(400);
  });

  test("non-member -> 403; unknown release -> 404; no auth -> 401", async () => {
    const denied = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(otherAccessToken), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    expect(denied.status).toBe(403);
    const missing = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${randomUUID()}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    expect(missing.status).toBe(404);
    const noauth = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    expect(noauth.status).toBe(401);
  });
});

describe("bin download", () => {
  test("project member downloads directly with Bearer", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/bin`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([...makeBin(1024, 3)]);
  });

  test("non-member Bearer -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/bin`, {
        headers: authHeaders(otherAccessToken),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("device downloads with its per-device JWT (no Bearer)", async () => {
    const token = await signOtaToken(TEST_JWT.secret, {
      deviceUid,
      releaseId: createdReleaseId,
      jobId: randomUUID(),
    }, 900);
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([...makeBin(1024, 3)]);
  });

  test("no credentials -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/bin`),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "invalid_download_token" });
  });

  test("garbage token -> 403", async () => {
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=not-a-jwt`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("expired token -> 403", async () => {
    const token = await signOtaToken(TEST_JWT.secret, {
      deviceUid,
      releaseId: createdReleaseId,
      jobId: randomUUID(),
    }, -1);
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("token for a different release -> 403", async () => {
    const token = await signOtaToken(TEST_JWT.secret, {
      deviceUid,
      releaseId: randomUUID(),
      jobId: randomUUID(),
    }, 900);
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("token for an unknown device -> 403", async () => {
    const token = await signOtaToken(TEST_JWT.secret, {
      deviceUid: "no-such-device",
      releaseId: createdReleaseId,
      jobId: randomUUID(),
    }, 900);
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("token for a device outside the release project -> 403", async () => {
    // sign a token for the cross-project device (same project as the
    // release is NOT checked at issuance, only at download)
    const token = await signOtaToken(TEST_JWT.secret, {
      deviceUid: "ota-api-x",
      releaseId: createdReleaseId,
      jobId: randomUUID(),
    }, 900);
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/ota-jobs/:id", () => {
  test("returns job detail with target states and current firmware", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    expect(res.status).toBe(201);
    const { job_id } = (await res.json()) as { job_id: string };
    // drive the target to a terminal state via a direct ack for a clean summary
    const job = await prisma.otaJob.findUnique({
      where: { id: job_id },
      select: { releaseId: true },
    });
    await prisma.otaTarget.updateMany({
      where: { jobId: job_id },
      data: { state: "downloaded", deliveredAt: new Date() },
    });
    const detail = await app.handle(
      new Request(`http://localhost/v1/ota-jobs/${job_id}`, { headers: authHeaders() }),
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      job_id: string;
      release_id: string;
      targets: Array<{ device_uid: string; state: string }>;
      summary: Record<string, number>;
    };
    expect(body.release_id).toBe(createdReleaseId);
    expect(body.targets).toEqual([
      expect.objectContaining({ device_uid: deviceUid, state: "downloaded" }),
    ]);
    expect(body.summary.downloaded).toBe(1);
    expect(job?.releaseId).toBe(createdReleaseId);
  });

  test("non-member -> 403; unknown job -> 404", async () => {
    // a real job in the owner's project, queried by a non-member
    const up = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/deploy`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId] }),
      }),
    );
    const { job_id: realJobId } = (await up.json()) as { job_id: string };
    const denied = await app.handle(
      new Request(`http://localhost/v1/ota-jobs/${realJobId}`, {
        headers: authHeaders(otherAccessToken),
      }),
    );
    expect(denied.status).toBe(403);
    const missing = await app.handle(
      new Request(`http://localhost/v1/ota-jobs/${randomUUID()}`, {
        headers: authHeaders(),
      }),
    );
    expect(missing.status).toBe(404);
  });
});
