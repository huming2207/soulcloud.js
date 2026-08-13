import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import { MAX_ELF_BYTES, prisma } from "@soulcloud/core";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";

// G group: these endpoints require a logged-in user.
const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

// HTTP-level tests for the logging routes (ELF upload, log query,
// firmware-state). Uses synthetic ELFs, no external fixtures.

const app = createApp(prisma, TEST_JWT);

let projectId: string;
let deviceId: string;
let deviceUid: string;
let artifactId: string;
let buildId: string;
let accessToken = "";

async function registerUser(): Promise<{ userId: string; accessToken: string }> {
  const username = `log-user-${randomUUID().slice(0, 8)}`;
  const res = await app.handle(
    new Request("http://localhost/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-password-123", email: `${username}@example.com` }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return { userId: body.user_id, accessToken: body.access_token };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

/** A minimal ELF with one format and one tag in .noload. */
const testElf = buildNoloadElf(["value=%d"], ["demo"], 32, true);
const testElfBuildId = (() => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(testElf).digest("hex");
})();

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, name: "api-logging-test" },
  });
  const { userId, accessToken: token } = await registerUser();
  accessToken = token;
  await prisma.userProject.create({ data: { userId, projectId } });
  deviceUid = `api-log-${randomUUID().slice(0, 8)}`;
  const device = await prisma.device.create({
    data: {
      id: randomUUID(),
      deviceUid,
      assignedId: "assigned-api-log",
      passwordHash: "unused",
      projectId,
    },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.rawLogEvent.deleteMany({ where: { deviceId } });
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId } });
  await prisma.firmwareLogString.deleteMany({ where: { artifactId } });
  await prisma.firmwareArtifact.deleteMany({ where: { id: artifactId } });
  await prisma.device.deleteMany({ where: { id: deviceId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

function uploadForm(overrides: Record<string, unknown> = {}): FormData {
  const form = new FormData();
  form.append("project_id", String(overrides.project_id ?? projectId));
  if (overrides.version) form.append("version", String(overrides.version));
  form.append(
    "file",
    new Blob([(overrides.elf ?? testElf) as Uint8Array]),
    "firmware.elf",
  );
  return form;
}

describe("POST /v1/firmware-artifacts", () => {
  test("uploads and imports an ELF (201)", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm(),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact_id: string;
      build_id: string;
      tag_count: number;
      format_count: number;
      import_state: string;
    };
    artifactId = body.artifact_id;
    expect(body.build_id).toBe(testElfBuildId);
    expect(body.tag_count).toBeGreaterThanOrEqual(1);
    expect(body.format_count).toBeGreaterThanOrEqual(1);
    expect(body.import_state).toBe("imported");
  });

  test("re-uploading the same build is idempotent (200)", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: authHeaders(),
        body: uploadForm(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string };
    expect(body.artifact_id).toBe(artifactId);
  });

  test("missing file -> 400 invalid_request", async () => {
    const form = new FormData();
    form.append("project_id", projectId);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        headers: authHeaders(),
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("unknown project -> 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        headers: authHeaders(),
        method: "POST",
        body: uploadForm({ project_id: randomUUID() }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "project_not_found" });
  });

  test("non-ELF file -> 422 invalid_elf", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        headers: authHeaders(),
        method: "POST",
        body: uploadForm({ elf: new TextEncoder().encode("not an elf") }),
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_elf" });
  });

  test("oversized file -> 413", async () => {
    const big = new Uint8Array(33 * 1024 * 1024); // 33MB
    big.set([0x7f, 0x45, 0x4c, 0x46], 0);
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        headers: authHeaders(),
        method: "POST",
        body: uploadForm({ elf: big }),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
  });
});

// S5 regression: oversized uploads must be rejected BEFORE the body is fully
// buffered. Note that Bun never sets a content-length header on constructed
// Requests, so `app.handle` bodies always reach the handler with
// content-length === null and are read through the chunked stream-cap path.
// These tests pin down that path (early stream abort -> 413) which the plain
// 33MB test above does not distinguish (it would still 413 via a full-buffer
// import-time too_large check).
describe("S5: oversized upload rejection (declared + chunked)", () => {
  test("chunked upload over the cap -> 413, aborted mid-stream", async () => {
    const CHUNK = 1024 * 1024; // 1MiB
    const TOTAL_CHUNKS = 40; // 40MiB total, well over the 32MiB + 64KiB cap
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls <= TOTAL_CHUNKS) controller.enqueue(new Uint8Array(CHUNK));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: authHeaders(), // no content-length: chunked path
        body,
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
    // early rejection: the body stream was cancelled before being drained
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(TOTAL_CHUNKS);
  });

  test("chunked upload under the cap is not rejected as 413", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024)); // 1MiB < cap
        controller.close();
      },
    });
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: authHeaders(),
        body,
      }),
    );
    // size gate must not fire; the raw bytes then fail multipart parsing
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("declared content-length over the cap -> 413 from the header check alone", async () => {
    // a tiny actual body with an oversized declared length: only the cheap
    // header check can produce the 413 (the real bytes are far under the cap)
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-length": String(MAX_ELF_BYTES + 2 * 1024 * 1024),
        },
        body: new Uint8Array(16),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
  });

  test("declared content-length under the cap is not rejected as 413", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: { ...authHeaders(), "content-length": "1024" },
        body: new Uint8Array(16),
      }),
    );
    // declared 1024 < cap -> size gate must not fire; raw bytes then fail
    // multipart parsing -> 400 invalid_request
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /v1/firmware-artifacts", () => {
  test("lists artifacts for a project", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-artifacts?project_id=${projectId}`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: Array<{ artifact_id: string }> };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(body.artifacts[0]!.artifact_id).toBe(artifactId);
  });

  test("missing project_id -> 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", { headers: authHeaders() }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /v1/devices/:id/logs", () => {
  test("queries stored logs with decoding", async () => {
    // seed one raw event (as the broker would)
    await prisma.rawLogEvent.create({
      data: {
        deviceId,
        artifactId,
        deviceTimeMs: 42,
        sequence: 1,
        packetType: 0,
        level: 3,
        tagId: 0x40000009, // "demo" in the synthetic ELF
        fmtId: 0x40000000, // "value=%d"
        rawPacket: new Uint8Array([0x9a, 0x03, 0x01, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x01, 0x01, 0x07, 0x00, 0x00, 0x00]),
        decodeState: "decodable",
      },
    });

    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=10`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        id: string;
        message: string | null;
        tag: string | null;
        decode_state: string;
        raw_packet_b64: string | undefined;
      }>;
      next_cursor: string | null;
    };
    expect(body.events.length).toBe(1);
    const event = body.events[0]!;
    expect(event.tag).toBe("demo");
    expect(event.message).toBe("value=7");
    expect(event.decode_state).toBe("decodable");
    // raw is excluded by default
    expect(event.raw_packet_b64).toBeUndefined();
    expect(body.next_cursor).toBeNull();
  });

  test("include_raw=1 returns the raw packet", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=10&include_raw=1`, {
        headers: authHeaders(),
      }),
    );
    const body = (await res.json()) as {
      events: Array<{ raw_packet_b64?: string }>;
    };
    expect(body.events[0]!.raw_packet_b64).toBeDefined();
    const raw = Buffer.from(body.events[0]!.raw_packet_b64!, "base64");
    expect(raw[0]).toBe(0x9a);
  });

  test("pagination: limit and cursor", async () => {
    // add a second event
    await prisma.rawLogEvent.create({
      data: {
        deviceId,
        artifactId: null,
        deviceTimeMs: 43,
        sequence: 2,
        packetType: 1, // DROPPED
        rawPacket: new Uint8Array([0x9a, 0x11, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]),
        decodeState: "unknown_fw",
      },
    });

    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=1`, {
        headers: authHeaders(),
      }),
    );
    const body = (await res.json()) as {
      events: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.events).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();

    // second page via cursor
    const res2 = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=1&cursor=${body.next_cursor}`, {
        headers: authHeaders(),
      }),
    );
    const body2 = (await res2.json()) as { events: Array<{ id: string }> };
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0]!.id).not.toBe(body.events[0]!.id);
  });

  test("unknown device -> 404", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${randomUUID()}/logs`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "device_not_found" });
  });

  test("limit above the cap is rejected (400)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=99999`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("limit=500 is accepted", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=500`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
  });
});

describe("device firmware state", () => {
  test("GET returns 404 before any report", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(404);
  });

  test("POST binds a device to an artifact", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ artifact_id: artifactId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string };
    expect(body.artifact_id).toBe(artifactId);

    // now GET resolves the artifact
    const getRes = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        headers: authHeaders(),
      }),
    );
    const state = (await getRes.json()) as {
      fw_hash: string;
      artifact_id: string | null;
      device_uid: string;
    };
    expect(state.fw_hash).toBe(testElfBuildId);
    expect(state.artifact_id).toBe(artifactId);
    expect(state.device_uid).toBe(deviceUid);
  });

  test("POST with unknown artifact -> 404", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ artifact_id: randomUUID() }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "artifact_not_found" });
  });

  test("POST with malformed body -> 400", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("audit regressions", () => {
  test("cursor=abc -> 400 (no internal error leak)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?cursor=abc`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("concurrent uploads of the same ELF create one artifact", async () => {
    const results = await Promise.allSettled([
      app.handle(new Request("http://localhost/v1/firmware-artifacts", { method: "POST", headers: authHeaders(), body: uploadForm() })),
      app.handle(new Request("http://localhost/v1/firmware-artifacts", { method: "POST", headers: authHeaders(), body: uploadForm() })),
      app.handle(new Request("http://localhost/v1/firmware-artifacts", { method: "POST", headers: authHeaders(), body: uploadForm() })),
    ]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    // at least one 201/200 and no 500s
    expect(statuses.every((s) => s === 200 || s === 201)).toBe(true);
    const count = await prisma.firmwareArtifact.count({
      where: { projectId },
    });
    expect(count).toBe(1);
  });

  test("POST firmware-state with cross-project artifact -> 403", async () => {
    const otherProject = randomUUID();
    await prisma.project.create({ data: { id: otherProject, name: "other-project" } });
    // a user of the OTHER project uploads its artifact
    const otherUser = await registerUser();
    await prisma.userProject.create({
      data: { userId: otherUser.userId, projectId: otherProject },
    });
    const otherElf = buildNoloadElf(["x=%d"], ["other"], 32, true);
    const otherForm = new FormData();
    otherForm.append("project_id", otherProject);
    otherForm.append("file", new Blob([otherElf]), "f.elf");
    const up = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts", {
        method: "POST",
        headers: { authorization: `Bearer ${otherUser.accessToken}` },
        body: otherForm,
      }),
    );
    expect(up.status).toBe(201);
    const upBody = (await up.json()) as { artifact_id: string };

    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ artifact_id: upBody.artifact_id }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "artifact_project_mismatch" });

    await prisma.firmwareLogString.deleteMany({ where: { artifactId: upBody.artifact_id } });
    await prisma.firmwareArtifact.deleteMany({ where: { id: upBody.artifact_id } });
    await prisma.project.delete({ where: { id: otherProject } });
  });
});

describe("GET /v1/devices/:id/logs/export", () => {
  const seed = async (receivedAt: Date, deviceTimeMs: number) => {
    await prisma.rawLogEvent.create({
      data: {
        deviceId,
        artifactId,
        deviceTimeMs,
        sequence: 1,
        packetType: 0,
        level: 3,
        tagId: 0x40000009,
        fmtId: 0x40000000,
        rawPacket: new Uint8Array(24),
        decodeState: "decodable",
        receivedAt,
      },
    });
  };

  const exportUrl = (qs: string) =>
    `http://localhost/v1/devices/${deviceId}/logs/export?${qs}`;

  test("requires authentication (401)", async () => {
    const res = await app.handle(new Request(exportUrl("from=2026-08-01T00:00:00Z")));
    expect(res.status).toBe(401);
  });

  test("from is required and must be ISO 8601 (400)", async () => {
    for (const qs of ["", "from=not-a-date"]) {
      const res = await app.handle(new Request(exportUrl(qs), { headers: authHeaders() }));
      expect(res.status).toBe(400);
    }
  });

  test("from later than to -> 400", async () => {
    const res = await app.handle(
      new Request(
        exportUrl("from=2026-08-10T00:00:00Z&to=2026-08-01T00:00:00Z"),
        { headers: authHeaders() },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("exports only events inside the time range as CSV", async () => {
    const outside = new Date("2026-08-01T00:00:00Z");
    const inside1 = new Date("2026-08-10T01:00:00Z");
    const inside2 = new Date("2026-08-10T02:00:00Z");
    await seed(outside, 100);
    await seed(inside1, 200);
    await seed(inside2, 300);

    const res = await app.handle(
      new Request(
        exportUrl("from=2026-08-10T00:00:00Z&to=2026-08-10T03:00:00Z"),
        { headers: authHeaders() },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(
      `${deviceUid}-logs.csv`,
    );
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "received_at,device_time_ms,sequence,packet_type,level,tag,message,decode_state",
    );
    expect(lines.length).toBe(3); // header + 2 in-range rows
    expect(lines[1]).toContain("2026-08-10T01:00:00");
    expect(lines[1]).toContain("200");
    expect(lines[2]).toContain("2026-08-10T02:00:00");
    expect(text).not.toContain("2026-08-01");

    await prisma.rawLogEvent.deleteMany({
      where: { deviceId, receivedAt: { gte: outside, lte: inside2 } },
    });
  });

  test("limit caps the exported rows", async () => {
    await seed(new Date("2026-08-12T00:00:00Z"), 1);
    await seed(new Date("2026-08-12T00:00:01Z"), 2);
    const res = await app.handle(
      new Request(
        exportUrl("from=2026-08-11T00:00:00Z&limit=1"),
        { headers: authHeaders() },
      ),
    );
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n");
    expect(lines.length).toBe(2); // header + 1 row
    await prisma.rawLogEvent.deleteMany({
      where: { deviceId, receivedAt: { gte: new Date("2026-08-12T00:00:00Z") } },
    });
  });
});

describe("H1: project membership on logging endpoints", () => {
  test("non-member cannot list artifacts, read or write firmware-state (403)", async () => {
    // register an outsider with no membership
    const username = `h1-out-${randomUUID().slice(0, 8)}`;
    const res = await app.handle(
      new Request("http://localhost/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "test-password-123", email: `${username}@example.com` }),
      }),
    );
    const { access_token: outsiderToken } = (await res.json()) as { access_token: string };
    const outsider = { authorization: `Bearer ${outsiderToken}` };

    // 1. list artifacts of the project
    const list = await app.handle(
      new Request(`http://localhost/v1/firmware-artifacts?project_id=${projectId}`, {
        headers: outsider,
      }),
    );
    expect(list.status).toBe(403);

    // 2. read firmware-state of the project's device
    const readState = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        headers: outsider,
      }),
    );
    expect(readState.status).toBe(403);

    // 3. write firmware-state (bind artifact) of the project's device
    const writeState = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { ...outsider, "content-type": "application/json" },
        body: JSON.stringify({ artifact_id: artifactId }),
      }),
    );
    expect(writeState.status).toBe(403);

    // the owner can still do all three
    const ownerList = await app.handle(
      new Request(`http://localhost/v1/firmware-artifacts?project_id=${projectId}`, {
        headers: authHeaders(),
      }),
    );
    expect(ownerList.status).toBe(200);
    const ownerRead = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        headers: authHeaders(),
      }),
    );
    expect(ownerRead.status).toBe(200);
  });

  test("unknown project on artifact list -> 404 (no existence oracle)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-artifacts?project_id=${randomUUID()}`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(404);
  });
});
