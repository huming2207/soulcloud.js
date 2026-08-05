/**
 * HTTP-level tests for the P0 device-management routes:
 *   GET  /v1/me                        current user + project list
 *   GET  /v1/projects/:id/devices      device list (offset-paginated)
 *   GET  /v1/devices/:id               device detail
 *   POST /v1/devices                   create a device (credential shown once)
 *   GET  /v1/devices/:id/commands      per-device command history
 *   GET  /v1/command-batches/:id       batch detail with per-device results
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma, encodeDeviceCommandResult } from "@soulcloud/core";
import { createApp } from "../../src/api/app";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);

let projectId = "";
let ownerToken = "";
let ownerUserId = "";
let outsiderToken = "";
let deviceIds: string[] = [];
let createdDeviceIds: string[] = [];

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

function jsonHeaders(token = ownerToken): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function postJson(path: string, body: unknown, token = ownerToken): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    }),
  );
}

async function getJson(path: string, token = ownerToken): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "devmgmt-api-test" } });
  const owner = await registerUser("devmgmt-owner");
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  await prisma.userProject.create({ data: { userId: owner.userId, projectId } });
  const outsider = await registerUser("devmgmt-outsider");
  outsiderToken = outsider.token;
  for (let i = 0; i < 3; i++) {
    const device = await prisma.device.create({
      data: {
        id: randomUUID(),
        deviceUid: `devmgmt-${i}-${randomUUID().slice(0, 8)}`,
        assignedId: `assigned-devmgmt-${i}`,
        passwordHash: "unused-hash",
        projectId,
      },
    });
    deviceIds.push(device.id);
  }
  // one device reports firmware so the list/detail include the state
  await prisma.deviceFirmwareState.create({
    data: {
      deviceId: deviceIds[0]!,
      fwHash: "aa".repeat(32),
      reportedAt: new Date(),
    },
  });
});

afterAll(async () => {
  const allDeviceIds = [...deviceIds, ...createdDeviceIds];
  await prisma.deviceCommand.deleteMany({ where: { deviceId: { in: allDeviceIds } } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.deviceFirmwareState.deleteMany({ where: { deviceId: { in: allDeviceIds } } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("GET /v1/me", () => {
  test("returns the user with their projects and device counts", async () => {
    const res = await getJson("/v1/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user_id: string;
      username: string;
      projects: Array<{ project_id: string; name: string; device_count: number }>;
    };
    expect(body.user_id).toBeTruthy();
    expect(body.username).toBeTruthy();
    const testProject = body.projects.find((p) => p.project_id === projectId);
    expect(testProject).toEqual({
      project_id: projectId,
      name: "devmgmt-api-test",
      device_count: 3,
    });
  });

  test("requires authentication (401)", async () => {
    const res = await app.handle(new Request("http://localhost/v1/me"));
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/devices", () => {
  test("creates a device with a one-time credential (201)", async () => {
    const deviceUid = `new-uid-${randomUUID().slice(0, 8)}`;
    const res = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: "new-assigned",
      device_uid: deviceUid,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      device_id: string;
      device_uid: string;
      assigned_id: string;
      mqtt_username: string;
      mqtt_password: string;
      note: string;
    };
    expect(body.device_uid).toBe(deviceUid);
    expect(body.mqtt_username).toBe(deviceUid);
    expect(body.mqtt_password.length).toBeGreaterThanOrEqual(16);
    expect(body.note).toContain("once");
    createdDeviceIds.push(body.device_id);

    const row = await prisma.device.findUnique({
      where: { id: body.device_id },
      select: { passwordHash: true, authRevoked: true },
    });
    // argon2id hash stored, NOT the plaintext password
    expect(row?.passwordHash).toStartWith("$argon2id$");
    expect(row?.authRevoked).toBe(false);
  });

  test("rejects a taken device_uid with 409 device_uid_taken", async () => {
    const uid = `dup-uid-${randomUUID().slice(0, 8)}`;
    const first = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: "dup-a",
      device_uid: uid,
    });
    expect(first.status).toBe(201);
    createdDeviceIds.push(((await first.json()) as { device_id: string }).device_id);
    const second = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: "dup-b",
      device_uid: uid,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("device_uid_taken");
  });

  test("rejects a taken assigned_id within the project (409), allows it cross-project", async () => {
    const assignedId = `dup-assigned-${randomUUID().slice(0, 8)}`;
    const first = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: assignedId,
      device_uid: `x-uid-${randomUUID().slice(0, 8)}`,
    });
    expect(first.status).toBe(201);
    createdDeviceIds.push(((await first.json()) as { device_id: string }).device_id);
    const second = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: assignedId,
      device_uid: `y-uid-${randomUUID().slice(0, 8)}`,
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("assigned_id_taken");
    // another project may reuse the same assigned_id (uniqueness is per project)
    const otherProject = randomUUID();
    await prisma.project.create({ data: { id: otherProject, name: "devmgmt-other" } });
    await prisma.userProject.create({
      data: { userId: ownerUserId, projectId: otherProject },
    });
    const cross = await postJson("/v1/devices", {
      project_id: otherProject,
      assigned_id: assignedId,
      device_uid: `z-uid-${randomUUID().slice(0, 8)}`,
    });
    expect(cross.status).toBe(201);
    createdDeviceIds.push(((await cross.json()) as { device_id: string }).device_id);
    await prisma.device.deleteMany({ where: { projectId: otherProject } });
    await prisma.project.delete({ where: { id: otherProject } });
  });

  test("rejects unsafe device_uid with 422 invalid_device_uid", async () => {
    for (const uid of ["has/slash", "has+plus", "has#hash", "has space", "has\ttab"]) {
      const res = await postJson("/v1/devices", {
        project_id: projectId,
        assigned_id: `unsafe-${randomUUID().slice(0, 8)}`,
        device_uid: uid,
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_device_uid");
    }
  });

  test("rejects missing fields with 400", async () => {
    const res = await postJson("/v1/devices", { project_id: projectId });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  test("enforces membership and existence (403/404/401)", async () => {
    const unknownProject = randomUUID();
    const notFound = await postJson("/v1/devices", {
      project_id: unknownProject,
      assigned_id: "no-project",
      device_uid: `no-project-${randomUUID().slice(0, 8)}`,
    });
    expect(notFound.status).toBe(404);
    const forbidden = await postJson("/v1/devices", {
      project_id: projectId,
      assigned_id: "no-membership",
      device_uid: `no-membership-${randomUUID().slice(0, 8)}`,
    }, outsiderToken);
    expect(forbidden.status).toBe(403);
    const noAuth = await app.handle(
      new Request("http://localhost/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          assigned_id: "no-auth",
          device_uid: `no-auth-${randomUUID().slice(0, 8)}`,
        }),
      }),
    );
    expect(noAuth.status).toBe(401);
  });
});

describe("GET /v1/projects/:id/devices", () => {
  test("lists devices with firmware state and total", async () => {
    const res = await getJson(`/v1/projects/${projectId}/devices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      devices: Array<{
        device_id: string;
        device_uid: string;
        assigned_id: string;
        auth_revoked: boolean;
        firmware: { fw_hash: string; reported_at: string } | null;
      }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(3);
    const withFw = body.devices.find((d) => d.device_id === deviceIds[0]);
    expect(withFw?.firmware?.fw_hash).toBe("aa".repeat(32));
    expect(body.devices.every((d) => d.device_id && d.device_uid && d.assigned_id)).toBe(true);
  });

  test("respects limit/offset pagination", async () => {
    const res = await getJson(`/v1/projects/${projectId}/devices?limit=2&offset=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; devices: unknown[] };
    expect(body.devices).toHaveLength(2);
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  test("rejects bad params, unknown project, non-member, no auth", async () => {
    expect((await getJson(`/v1/projects/${projectId}/devices?limit=0`)).status).toBe(400);
    expect((await getJson(`/v1/projects/${projectId}/devices?offset=-1`)).status).toBe(400);
    expect((await getJson(`/v1/projects/${randomUUID()}/devices`)).status).toBe(404);
    expect((await getJson(`/v1/projects/${projectId}/devices`, outsiderToken)).status).toBe(403);
    expect((await app.handle(new Request(`http://localhost/v1/projects/${projectId}/devices`))).status).toBe(401);
  });
});

describe("GET /v1/devices/:id", () => {
  test("returns device detail with project and firmware", async () => {
    const res = await getJson(`/v1/devices/${deviceIds[0]}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_id: string;
      device_uid: string;
      assigned_id: string;
      project_id: string;
      auth_revoked: boolean;
      next_command_sequence: string;
      firmware: { fw_hash: string } | null;
    };
    expect(body.device_id).toBe(deviceIds[0]!);
    expect(body.project_id).toBe(projectId);
    expect(body.next_command_sequence).toBe("1");
    expect(body.firmware?.fw_hash).toBe("aa".repeat(32));
  });

  test("unknown device -> 404; non-member -> 403; no auth -> 401", async () => {
    expect((await getJson(`/v1/devices/${randomUUID()}`)).status).toBe(404);
    expect((await getJson(`/v1/devices/${deviceIds[0]}`, outsiderToken)).status).toBe(403);
    expect((await app.handle(new Request(`http://localhost/v1/devices/${deviceIds[0]}`))).status).toBe(401);
  });
});

describe("GET /v1/devices/:id/commands", () => {
  test("returns decoded command history (newest first) with keyset cursor", async () => {
    const batch = await postJson("/v1/command-batches", {
      device_ids: [deviceIds[0], deviceIds[1]],
      command: { cmd: "setLogging", args: [{ enabled: true }] },
    });
    expect(batch.status).toBe(202);
    const batchId = ((await batch.json()) as { batch_id: string }).batch_id;
    // second batch so the first page is full and the cursor is exercised
    await postJson("/v1/command-batches", {
      device_ids: [deviceIds[0]],
      command: { cmd: "reboot", args: [{ delay_ms: 100 }] },
    });

    const res = await getJson(`/v1/devices/${deviceIds[0]}/commands?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commands: Array<{
        command_id: string;
        batch_id: string;
        sequence: string;
        command: { cmd: string; args: unknown } | null;
        state: string;
        result: unknown;
      }>;
      next_cursor: string | null;
    };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.command?.cmd).toBe("reboot");
    expect(body.commands[0]!.state).toBe("queued");
    expect(body.next_cursor).not.toBeNull();

    // page two via the cursor: the older setLogging command
    const page2 = await getJson(
      `/v1/devices/${deviceIds[0]}/commands?limit=1&cursor=${body.next_cursor}`,
    );
    const page2Body = (await page2.json()) as {
      commands: Array<{ batch_id: string; command: { cmd: string } | null }>;
      next_cursor: string | null;
    };
    expect(page2Body.commands[0]?.command?.cmd).toBe("setLogging");
    expect(page2Body.commands[0]?.batch_id).toBe(batchId);
  });

  test("decodes terminal results (result code + payload)", async () => {
    // complete the command on the DB as the broker would
    const row = await prisma.deviceCommand.findFirst({
      where: { deviceId: deviceIds[0], state: "queued" },
      orderBy: { sequence: "desc" },
    });
    expect(row).not.toBeNull();
    const commandId = row!.id;
    await prisma.deviceCommand.update({
      where: { id: commandId },
      data: {
        state: "device_completed",
        // CHECK constraints: device_completed requires broker_accepted_at,
        // result_code, result_packet and device_completed_at all set
        brokerAcceptedAt: new Date(),
        resultCode: 0,
        resultPacket: Buffer.from(
          encodeDeviceCommandResult({
            id: Buffer.from(commandId.replace(/-/g, ""), "hex"),
            seq: row!.sequence,
            code: 0,
            payload: [{ status: "ok" }],
          }),
        ),
        deviceCompletedAt: new Date(),
      },
    });
    const res = await getJson(`/v1/devices/${deviceIds[0]}/commands?limit=1`);
    const body = (await res.json()) as {
      commands: Array<{ state: string; result_code: number; result: { code: number; payload: unknown } }>;
    };
    expect(body.commands[0]!.state).toBe("device_completed");
    expect(body.commands[0]!.result_code).toBe(0);
    expect(body.commands[0]!.result?.code).toBe(0);
    expect(body.commands[0]!.result?.payload).toEqual([{ status: "ok" }]);
  });

  test("empty device has no commands; unknown -> 404; non-member -> 403", async () => {
    const res = await getJson(`/v1/devices/${deviceIds[2]}/commands`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { commands: unknown[] }).commands).toEqual([]);
    expect((await getJson(`/v1/devices/${randomUUID()}/commands`)).status).toBe(404);
    expect((await getJson(`/v1/devices/${deviceIds[0]}/commands`, outsiderToken)).status).toBe(403);
  });
});

describe("GET /v1/command-batches/:id", () => {
  test("returns batch detail with summary and per-device commands", async () => {
    const batch = await postJson("/v1/command-batches", {
      device_ids: [deviceIds[1], deviceIds[2]],
      command: { cmd: "setLevel", args: [{ level: 3 }] },
    });
    expect(batch.status).toBe(202);
    const { batch_id, device_count } = (await batch.json()) as {
      batch_id: string;
      device_count: number;
    };
    const res = await getJson(`/v1/command-batches/${batch_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      batch_id: string;
      device_count: number;
      summary: Record<string, number>;
      commands: Array<{ device_uid: string; command: { cmd: string; args: unknown } | null }>;
    };
    expect(body.batch_id).toBe(batch_id);
    expect(body.device_count).toBe(device_count);
    expect(body.summary.queued).toBe(2);
    expect(body.commands).toHaveLength(2);
    expect(body.commands.every((c) => c.command?.cmd === "setLevel")).toBe(true);
  });

  test("unknown batch -> 404; non-member -> 403; no auth -> 401", async () => {
    expect((await getJson(`/v1/command-batches/${randomUUID()}`)).status).toBe(404);
    const batch = await postJson("/v1/command-batches", {
      device_ids: [deviceIds[0]],
      command: { cmd: "noop" },
    });
    const { batch_id } = (await batch.json()) as { batch_id: string };
    expect((await getJson(`/v1/command-batches/${batch_id}`, outsiderToken)).status).toBe(403);
    expect((await app.handle(new Request(`http://localhost/v1/command-batches/${batch_id}`))).status).toBe(401);
  });
});
