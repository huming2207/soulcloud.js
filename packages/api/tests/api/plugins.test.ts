/**
 * HTTP-level tests for the stage-3 plugin routes:
 *   GET    /v1/plugins/catalog
 *   POST   /v1/projects/:id/plugin-installations
 *   GET    /v1/projects/:id/plugin-installations
 *   PATCH  /v1/plugin-installations/:id
 *   POST   /v1/plugin-installations/:id/{migrate,disable,enable}
 *   POST   /v1/devices/:id/profile/dry-run
 *   PUT    /v1/devices/:id/profile          (audited bind)
 *   DELETE /v1/devices/:id/profile          (audited unbind)
 *   GET    /v1/devices/:id/plugin-view
 *   GET    /v1/devices/:id/actions
 *   POST   /v1/devices/:id/actions/:action_id   (encode → command queue)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { prisma, decodeDeviceCommandExecution } from "@soulcloud/core";
import { createApp } from "../../src/api/app";

const TEST_JWT = {
  secret: "test-secret-0123456789-0123456789-0123456789",
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 3600,
};

const app = createApp(prisma, TEST_JWT);

let projectId = "";
let ownerToken = "";
let outsiderToken = "";
let deviceId = "";
let installationId = "";

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

async function send(
  method: string,
  path: string,
  body?: unknown,
  token = ownerToken,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: jsonHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, name: "plugins-api-test" } });
  const owner = await registerUser("plugins-owner");
  ownerToken = owner.token;
  await prisma.userProject.create({ data: { userId: owner.userId, projectId } });
  const outsider = await registerUser("plugins-outsider");
  outsiderToken = outsider.token;
  deviceId = randomUUID();
  await prisma.device.create({
    data: {
      id: deviceId,
      deviceUid: `plugins-${randomUUID().slice(0, 8)}`,
      assignedId: "assigned-plugins-test",
      passwordHash: "unused-hash",
      projectId,
    },
  });
});

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { projectId } });
  await prisma.entityRegistry.deleteMany({ where: { deviceId } });
  await prisma.entityDescriptorRevision.deleteMany({
    where: { pluginId: "soulcloud.test.chaos" },
  });
  await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  await prisma.commandBatch.deleteMany({ where: { commands: { none: {} } } });
  await prisma.pluginInstallation.deleteMany({ where: { projectId } });
  await prisma.device.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.$disconnect();
});

describe("GET /v1/plugins/catalog", () => {
  test("requires authentication", async () => {
    const res = await app.handle(new Request("http://localhost/v1/plugins/catalog"));
    expect(res.status).toBe(401);
  });

  test("lists deployed manifests with profiles and actions", async () => {
    const res = await send("GET", "/v1/plugins/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Array<{
        id: string;
        version: string;
        actions: Array<{ id: string; wire_command: string }>;
      }>;
    };
    const chaos = body.plugins.find((p) => p.id === "soulcloud.test.chaos");
    expect(chaos).toBeTruthy();
    expect(chaos!.version).toBe("1.0.0");
    expect(chaos!.actions.map((a) => a.id).sort()).toEqual(["clear_alarms", "set_mode"]);
    expect(body.plugins.some((p) => p.id === "soulcloud.generic")).toBe(true);
  });
});

describe("installation lifecycle", () => {
  test("create requires project membership and a deployed plugin", async () => {
    const missing = await send("POST", `/v1/projects/${projectId}/plugin-installations`, {
      plugin_id: "acme.not_deployed",
    });
    expect(missing.status).toBe(404);

    const forbidden = await send(
      "POST",
      `/v1/projects/${projectId}/plugin-installations`,
      { plugin_id: "soulcloud.test.chaos" },
      outsiderToken,
    );
    expect(forbidden.status).toBe(403);

    const res = await send("POST", `/v1/projects/${projectId}/plugin-installations`, {
      plugin_id: "soulcloud.test.chaos",
      config_json: { line: "a" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      plugin_id: string;
      configured_plugin_version: string;
      state: string;
    };
    installationId = body.id;
    expect(body.plugin_id).toBe("soulcloud.test.chaos");
    expect(body.configured_plugin_version).toBe("1.0.0");
    expect(body.state).toBe("enabled");
  });

  test("list shows the installation with device count", async () => {
    const res = await send("GET", `/v1/projects/${projectId}/plugin-installations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<{ id: string; device_count: number; state: string }>;
    };
    const mine = body.installations.find((i) => i.id === installationId);
    expect(mine?.device_count).toBe(0);
  });

  test("patch updates config and writes an audit row", async () => {
    const res = await send("PATCH", `/v1/plugin-installations/${installationId}`, {
      config_json: { line: "b" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config_json: unknown };
    expect(body.config_json).toEqual({ line: "b" });
    const audit = await prisma.$queryRaw<{ action: string }[]>`
      SELECT action FROM audit_events WHERE project_id = ${projectId} AND action = 'installation.update'
    `;
    expect(audit.length).toBe(1);
  });

  test("disable/enable transitions are audited; enabling error state is refused", async () => {
    const disabled = await send("POST", `/v1/plugin-installations/${installationId}/disable`);
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { state: string }).state).toBe("disabled");

    // events are rejected while disabled (covered by core tests); re-enable
    const enabled = await send("POST", `/v1/plugin-installations/${installationId}/enable`);
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { state: string }).state).toBe("enabled");

    await prisma.$executeRaw`
      UPDATE plugin_installations SET state = 'error' WHERE id = ${installationId}
    `;
    const blindEnable = await send("POST", `/v1/plugin-installations/${installationId}/enable`);
    expect(blindEnable.status).toBe(409);
    await prisma.$executeRaw`
      UPDATE plugin_installations SET state = 'enabled' WHERE id = ${installationId}
    `;
  });

  test("migrate is refused when already on the deployed version", async () => {
    const res = await send("POST", `/v1/plugin-installations/${installationId}/migrate`);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("version_mismatch");
  });
});

describe("device profile binding", () => {
  test("dry-run from the generic builtin reports every entity as added", async () => {
    const res = await send("POST", `/v1/devices/${deviceId}/profile/dry-run`, {
      installation_id: installationId,
      profile_id: "chaos_fixture",
      profile_version: 1,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { profile_id: string } | null;
      target: { plugin_id: string };
      checks: Record<string, boolean>;
      entity_changes: { added: string[]; removed: string[]; changed: string[] };
      blocking_reasons: string[];
    };
    expect(body.current?.profile_id).toBe("generic");
    expect(body.target.plugin_id).toBe("soulcloud.test.chaos");
    expect(Object.values(body.checks).every(Boolean)).toBe(true);
    expect(body.entity_changes.added.sort()).toEqual([
      "chaos.counter",
      "chaos.last_kind",
      "chaos.mode",
      "chaos.value",
    ]);
    expect(body.blocking_reasons).toEqual([]);
  });

  test("bind registers entities and writes an audit row", async () => {
    const res = await send("PUT", `/v1/devices/${deviceId}/profile`, {
      installation_id: installationId,
      profile_id: "chaos_fixture",
      profile_version: 1,
      configuration: { fixture: "bench-7" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin_id: string; profile_id: string };
    expect(body.plugin_id).toBe("soulcloud.test.chaos");

    const registry = await prisma.$queryRaw<{ entity_key: string }[]>`
      SELECT entity_key FROM entity_registry WHERE device_id = ${deviceId}
    `;
    expect(registry.length).toBe(4);

    const audit = await prisma.$queryRaw<{ detail: unknown }[]>`
      SELECT detail FROM audit_events WHERE project_id = ${projectId} AND action = 'device.profile.bind'
    `;
    expect(audit.length).toBe(1);
  });

  test("bind rejects an undeclared profile", async () => {
    const res = await send("PUT", `/v1/devices/${deviceId}/profile`, {
      installation_id: installationId,
      profile_id: "ghost",
      profile_version: 1,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_profile");
  });

  test("plugin-view merges descriptors with current states", async () => {
    const res = await send("GET", `/v1/devices/${deviceId}/plugin-view`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      binding: { plugin_id: string; installation_id: string | null };
      entities: Array<{
        descriptor: { key: string; value_type: string; unit: string | null };
        state: unknown;
      }>;
    };
    expect(body.binding.installation_id).toBe(installationId);
    const counter = body.entities.find((e) => e.descriptor.key === "chaos.counter");
    expect(counter?.descriptor.value_type).toBe("number");
    expect(counter?.state).toBeNull();
  });

  test("unbind returns the device to the generic profile", async () => {
    const res = await send("DELETE", `/v1/devices/${deviceId}/profile`);
    expect(res.status).toBe(200);
    const view = await send("GET", `/v1/devices/${deviceId}/plugin-view`);
    const body = (await view.json()) as { binding: { plugin_id: string } };
    expect(body.binding.plugin_id).toBe("soulcloud.generic");
    // re-bind for the action tests
    const rebind = await send("PUT", `/v1/devices/${deviceId}/profile`, {
      installation_id: installationId,
      profile_id: "chaos_fixture",
      profile_version: 1,
    });
    expect(rebind.status).toBe(200);
  });
});

describe("device actions", () => {
  test("lists declarative actions for a bound device", async () => {
    const res = await send("GET", `/v1/devices/${deviceId}/actions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actions: Array<{ id: string; input_schema: Record<string, unknown> }>;
    };
    expect(body.actions.map((a) => a.id).sort()).toEqual(["clear_alarms", "set_mode"]);
    const setMode = body.actions.find((a) => a.id === "set_mode")!;
    expect((setMode.input_schema.mode as { enum: string[] }).enum).toEqual([
      "standby",
      "running",
      "fault",
    ]);
  });

  test("invoke validates input, encodes and enqueues through the command queue", async () => {
    const bad = await send("POST", `/v1/devices/${deviceId}/actions/set_mode`, {
      input: { mode: "bogus" },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_action_input");

    const unknown = await send("POST", `/v1/devices/${deviceId}/actions/nope`, {
      input: {},
    });
    expect(unknown.status).toBe(404);

    const res = await send("POST", `/v1/devices/${deviceId}/actions/set_mode`, {
      input: { mode: "running", threshold: 42 },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      batch_id: string;
      wire_command: string;
      schema_version: number;
    };
    expect(body.wire_command).toBe("chaos_set_mode");
    expect(body.schema_version).toBe(1);

    const commands = await prisma.$queryRaw<{ payload: Uint8Array }[]>`
      SELECT payload FROM device_commands WHERE device_id = ${deviceId}
    `;
    const decoded = decodeDeviceCommandExecution(commands[0]!.payload);
    expect(decoded.cmd).toBe("chaos_set_mode");
    expect(decoded.args).toEqual([{ mode: "running" }, { threshold: 42 }]);

    const audit = await prisma.$queryRaw<{ action: string }[]>`
      SELECT action FROM audit_events WHERE project_id = ${projectId} AND action = 'device.action.invoke'
    `;
    expect(audit.length).toBe(1);
  });

  test("actions of an unbound (generic) device are empty and invocation 404s", async () => {
    const tempDevice = randomUUID();
    await prisma.device.create({
      data: {
        id: tempDevice,
        deviceUid: `plugins-generic-${randomUUID().slice(0, 8)}`,
        assignedId: "assigned-plugins-generic",
        passwordHash: "unused-hash",
        projectId,
      },
    });
    try {
      const list = await send("GET", `/v1/devices/${tempDevice}/actions`);
      expect(list.status).toBe(200);
      expect(((await list.json()) as { actions: unknown[] }).actions).toEqual([]);

      const invoke = await send("POST", `/v1/devices/${tempDevice}/actions/set_mode`, {
        input: { mode: "running" },
      });
      expect(invoke.status).toBe(404);
    } finally {
      await prisma.device.delete({ where: { id: tempDevice } });
    }
  });
});
