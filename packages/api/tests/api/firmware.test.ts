/**
 * HTTP-level tests for the OTA firmware release routes: upload (bin
 * required, ELF optional), idempotency, listing, detail, and single-use
 * temporary download URLs (no Bearer required at the consumption end).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
});

afterAll(async () => {
  await prisma.firmwareDownloadToken.deleteMany({
    where: { release: { projectId: { in: [projectId, otherProjectId] } } },
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

describe("download tokens", () => {
  test("POST download-token requires membership, returns credential", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      url: string;
    };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.url).toContain(`/v1/firmware-releases/${createdReleaseId}/bin?token=`);
    const expiry = new Date(body.expires_at).getTime();
    expect(expiry).toBeGreaterThan(Date.now() + 120_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 180_000);

    // non-member cannot create one
    const denied = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(otherAccessToken),
      }),
    );
    expect(denied.status).toBe(403);
  });

  test("GET bin with a valid token downloads the exact bytes (no Bearer)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    const { token } = (await res.json()) as { token: string };
    const download = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect([...bytes]).toEqual([...makeBin(1024, 3)]);
  });

  test("token is single-use: second download refused", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    const { token } = (await res.json()) as { token: string };
    const first = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(first.status).toBe(200);
    const second = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: "invalid_download_token" });
  });

  test("garbage token -> 403", async () => {
    const res = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=not-a-real-token`,
      ),
    );
    expect(res.status).toBe(403);
  });

  test("no token -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/bin`),
    );
    expect(res.status).toBe(403);
  });

  test("token is release-scoped: cannot download another release", async () => {
    // create a second release
    const bin = makeBin(777, 9);
    const up = await app.handle(
      new Request("http://localhost/v1/firmware-releases", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm({ bin }),
      }),
    );
    const { release_id: otherReleaseId } = (await up.json()) as { release_id: string };
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    const { token } = (await res.json()) as { token: string };
    const cross = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${otherReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(cross.status).toBe(403);
  });

  test("expired token -> 403", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-releases/${createdReleaseId}/download-token`, {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    const { token } = (await res.json()) as { token: string };
    await prisma.firmwareDownloadToken.updateMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const download = await app.handle(
      new Request(
        `http://localhost/v1/firmware-releases/${createdReleaseId}/bin?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(download.status).toBe(403);
  });
});
