import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app";
import {
  prisma,
  type PrismaClient,
} from "@soulcloud/core";
import { buildNoloadElf } from "../../../core/tests/helpers/elf-builder";

// HTTP-level tests for the logging routes (ELF upload, log query,
// firmware-state). Uses synthetic ELFs, no external fixtures.

const app = createApp(prisma);

let projectId: string;
let deviceId: string;
let deviceUid: string;
let artifactId: string;
let buildId: string;

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
        method: "POST",
        body: uploadForm({ elf: big }),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
  });
});

describe("GET /v1/firmware-artifacts", () => {
  test("lists artifacts for a project", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/firmware-artifacts?project_id=${projectId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: Array<{ artifact_id: string }> };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(body.artifacts[0]!.artifact_id).toBe(artifactId);
  });

  test("missing project_id -> 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/firmware-artifacts"),
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
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=10`),
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
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=10&include_raw=1`),
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
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=1`),
    );
    const body = (await res.json()) as {
      events: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.events).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();

    // second page via cursor
    const res2 = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=1&cursor=${body.next_cursor}`),
    );
    const body2 = (await res2.json()) as { events: Array<{ id: string }> };
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0]!.id).not.toBe(body.events[0]!.id);
  });

  test("unknown device -> 404", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${randomUUID()}/logs`),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "device_not_found" });
  });

  test("limit above the cap is rejected (400)", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=99999`),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("limit=500 is accepted", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/logs?limit=500`),
    );
    expect(res.status).toBe(200);
  });
});

describe("device firmware state", () => {
  test("GET returns 404 before any report", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`),
    );
    expect(res.status).toBe(404);
  });

  test("POST binds a device to an artifact", async () => {
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifact_id: artifactId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string };
    expect(body.artifact_id).toBe(artifactId);

    // now GET resolves the artifact
    const getRes = await app.handle(
      new Request(`http://localhost/v1/devices/${deviceId}/firmware-state`),
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});
