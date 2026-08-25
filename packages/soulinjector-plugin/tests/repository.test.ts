import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DebugSessionConflictError, SoulInjectorRepository } from "../src/repository";

function fakePool(failMigration = false): { pool: Pool; queries: string[]; released: boolean } {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (query: string) => {
      queries.push(query);
      if (failMigration && query.includes("CREATE SCHEMA IF NOT EXISTS")) throw new Error("migration failed");
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    get released() { return released; },
  };
}

describe("SoulInjector private repository migration", () => {
  test("runs BEGIN, migration and COMMIT on the same checked-out client", async () => {
    const fake = fakePool();
    await new SoulInjectorRepository(fake.pool).migrate();
    expect(fake.queries[0]).toBe("BEGIN");
    expect(fake.queries[1]).toStartWith("\nCREATE SCHEMA IF NOT EXISTS soul_injector_plugin;");
    expect(fake.queries[1]).toContain("debug_artifacts_installation_project_created_idx");
    expect(fake.queries[2]).toBe("COMMIT");
    expect(fake.released).toBe(true);
  });

  test("rolls back and releases the client when migration fails", async () => {
    const fake = fakePool(true);
    await expect(new SoulInjectorRepository(fake.pool).migrate()).rejects.toThrow("migration failed");
    expect(fake.queries).toEqual(["BEGIN", expect.stringContaining("CREATE SCHEMA"), "ROLLBACK"]);
    expect(fake.released).toBe(true);
  });
});

describe("SoulInjector target configuration scope", () => {
  test("scopes the latest target config by installation and project", async () => {
    const calls: unknown[][] = [];
    const row = {
      id: "00000000-0000-4000-8000-000000000010",
      installation_id: "00000000-0000-4000-8000-000000000011",
      project_id: "00000000-0000-4000-8000-000000000012",
      revision: 1,
      yaml_content: "version: 1\ntargets:\n  - id: fixture\n    displayName: Fixture\n    architecture: cortex-m\n    chip: fixture\n    transport: swd\n    requiredPrimitives: [identify]",
      config_json: { version: 1, targets: [{ id: "fixture", displayName: "Fixture", architecture: "cortex-m", chip: "fixture", transport: "swd", requiredPrimitives: ["identify"] }] },
      sha256: "a".repeat(64),
      created_by: "00000000-0000-4000-8000-000000000013",
      created_at: new Date(0),
    };
    const repository = new SoulInjectorRepository({
      query: async (query: string, params?: unknown[]) => {
        calls.push(params ?? []);
        expect(query).toContain("installation_id = $1 AND project_id = $2");
        return { rows: [row], rowCount: 1 };
      },
    } as unknown as Pool);

    await expect(repository.getLatestTargetConfig(row.installation_id, row.project_id)).resolves.toMatchObject({
      installationId: row.installation_id,
      projectId: row.project_id,
      revision: 1,
    });
    expect(calls).toEqual([[row.installation_id, row.project_id]]);
  });
});

describe("SoulInjector artifact chunk assembly", () => {
  test("validates chunks in bounded fetches and assembles the bytea in PostgreSQL", async () => {
    const queries: string[] = [];
    let fetchCount = 0;
    const elf = new Uint8Array(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    const elfView = new DataView(elf.buffer);
    elfView.setUint16(18, 243, true);
    elfView.setUint32(20, 1, true);
    elfView.setBigUint64(24, 0x1000n, true);
    elfView.setUint16(52, 64, true);
    const firstChunk = Buffer.from(elf.subarray(0, 3));
    const finalChunk = Buffer.from(elf.subarray(3));
    const uploadRow = {
      installation_id: "installation-1",
      project_id: "project-1",
      case_id: null,
      created_by: "user-1",
      kind: "elf",
      filename: "image.elf",
      content_type: "application/x-elf",
      expected_size: 64,
      received_size: 3,
      completed_artifact_id: null,
    };
    const client = {
      query: async (query: string) => {
        queries.push(query);
        if (query.includes("SELECT * FROM soul_injector_plugin.artifact_uploads")) {
          return { rows: [uploadRow], rowCount: 1 };
        }
        if (query.startsWith("FETCH FORWARD")) {
          fetchCount += 1;
          return fetchCount === 1
            ? {
                rows: [
                  { offset_bytes: 0, size: firstChunk.byteLength, sha256: createHash("sha256").update(firstChunk).digest("hex"), content: firstChunk },
                  { offset_bytes: firstChunk.byteLength, size: finalChunk.byteLength, sha256: createHash("sha256").update(finalChunk).digest("hex"), content: finalChunk },
                ],
                rowCount: 2,
              }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ connect: async () => client } as unknown as Pool);

    await expect(repository.storeArtifactChunk({
      installationId: "installation-1",
      projectId: "project-1",
      userId: "user-1",
      uploadId: "00000000-0000-4000-8000-000000000001",
      kind: "elf",
      filename: "image.elf",
      contentType: "application/x-elf",
      totalSize: 64,
      offset: 3,
      final: true,
      chunk: new Uint8Array(finalChunk),
    })).resolves.toMatchObject({ complete: true, receivedBytes: 64 });
    expect(queries.some((query) => query.includes("DECLARE soulinjector_artifact_"))).toBe(true);
    expect(queries.some((query) => query.includes("string_agg(content, ''::bytea ORDER BY offset_bytes)"))).toBe(true);
    expect(queries.some((query) => query.includes("Buffer.concat"))).toBe(false);
  });
});

describe("SoulInjector observation scope", () => {
  test("requires device observations to belong to the session device", async () => {
    const client = {
      query: async (query: string, params?: unknown[]) => {
        if (query.includes("SELECT s.id FROM")) {
          return {
            rows: params?.[3] === "device-1" ? [{ id: "session-1" }] : [],
            rowCount: params?.[3] === "device-1" ? 1 : 0,
          };
        }
        if (query.includes("INSERT INTO soul_injector_plugin.debug_observations")) {
          return {
            rows: [{
              id: "observation-1",
              session_id: "session-1",
              event_ref: "event-1",
              source: "device",
              kind: "debug.status",
              structured_data: { state: "running" },
              artifact_id: null,
              created_at: new Date(0),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ connect: async () => client } as unknown as Pool);
    await expect(repository.appendDebugObservation({
      installationId: "installation-1",
      projectId: "project-1",
      sessionId: "session-1",
      soulcloudDeviceRef: "device-1",
      eventRef: "event-1",
      source: "device",
      kind: "debug.status",
      structuredData: { state: "running" },
    })).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(repository.appendDebugObservation({
      installationId: "installation-1",
      projectId: "project-1",
      sessionId: "session-1",
      soulcloudDeviceRef: "device-2",
      eventRef: "event-2",
      source: "device",
      kind: "debug.status",
      structuredData: { state: "running" },
    })).rejects.toThrow("debug session is not available to this installation/project/device");
  });

  test("requires observation artifacts to belong to the same installation", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const client = {
      query: async (query: string, params?: unknown[]) => {
        queries.push({ query, params });
        if (query.includes("SELECT s.id FROM")) return { rows: [{ id: "session-1" }], rowCount: 1 };
        if (query.includes("FROM soul_injector_plugin.debug_artifacts")) return { rows: [{ id: "artifact-1" }], rowCount: 1 };
        if (query.includes("INSERT INTO soul_injector_plugin.debug_observations")) return {
          rows: [{ id: "observation-1", session_id: "session-1", event_ref: null, source: "plugin", kind: "snapshot", structured_data: {}, artifact_id: "artifact-1", created_at: new Date(0) }],
          rowCount: 1,
        };
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ connect: async () => client } as unknown as Pool);
    await repository.appendDebugObservation({ installationId: "installation-1", projectId: "project-1", sessionId: "session-1", artifactId: "artifact-1", source: "plugin", kind: "snapshot", structuredData: {} });
    const artifactQuery = queries.find((item) => item.query.includes("FROM soul_injector_plugin.debug_artifacts"));
    expect(artifactQuery?.query).toContain("installation_id = $2");
    expect(artifactQuery?.params).toEqual(["artifact-1", "installation-1", "project-1"]);
  });
});

describe("SoulInjector debug session idempotency", () => {
  const input = {
    installationId: "00000000-0000-4000-8000-000000000000",
    projectId: "00000000-0000-4000-8000-000000000001",
    caseId: "00000000-0000-4000-8000-000000000002",
    soulcloudDeviceRef: "00000000-0000-4000-8000-000000000003",
    executionRef: "00000000-0000-4000-8000-000000000004",
    pluginVersion: "0.1.0",
    manifestHash: "A".repeat(64),
    deviceFirmwareVersion: "firmware-1",
    startedBy: "00000000-0000-4000-8000-000000000005",
  };
  const existing = {
    id: "00000000-0000-4000-8000-000000000006",
    case_id: input.caseId,
    installation_id: input.installationId,
    soulcloud_device_ref: input.soulcloudDeviceRef,
    execution_ref: input.executionRef,
    state: "active",
    plugin_version: input.pluginVersion,
    manifest_hash: input.manifestHash.toLowerCase(),
    device_firmware_version: input.deviceFirmwareVersion,
    started_by: input.startedBy,
    controller: null,
    started_at: new Date(0),
    ended_at: null,
  };

  function repositoryForExistingSession(row: Record<string, unknown>) {
    const queries: string[] = [];
    const client = {
      query: async (query: string) => {
        queries.push(query);
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (query.includes("SELECT id FROM soul_injector_plugin.debug_cases")) return { rows: [{ id: input.caseId }], rowCount: 1 };
        if (query.includes("INSERT INTO soul_injector_plugin.debug_sessions")) return { rows: [], rowCount: 0 };
        if (query.includes("SELECT s.* FROM soul_injector_plugin.debug_sessions")) return { rows: [row], rowCount: 1 };
        throw new Error(`unexpected query: ${query}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    return { repository: new SoulInjectorRepository({ connect: async () => client } as unknown as Pool), queries };
  }

  test("reuses an existing session for a retried execution", async () => {
    const fake = repositoryForExistingSession(existing);
    const result = await fake.repository.createDebugSession(input);
    expect(result.id).toBe(existing.id);
    expect(result.manifestHash).toBe(input.manifestHash.toLowerCase());
    expect(fake.queries).toContain("COMMIT");
  });

  test("rejects an execution retry with conflicting session metadata", async () => {
    const fake = repositoryForExistingSession({ ...existing, case_id: "00000000-0000-4000-8000-000000000099" });
    await expect(fake.repository.createDebugSession(input)).rejects.toBeInstanceOf(DebugSessionConflictError);
    expect(fake.queries).toContain("ROLLBACK");
  });

  test("stores the target and artifact snapshot on session creation", async () => {
    const targetConfigId = "00000000-0000-4000-8000-000000000007";
    const artifactId = "00000000-0000-4000-8000-000000000008";
    const paramsSeen: unknown[][] = [];
    const row = {
      ...existing,
      id: "00000000-0000-4000-8000-000000000009",
      target_config_id: targetConfigId,
      target_config_revision: 2,
      target_id: "fixture",
      artifact_id: artifactId,
    };
    const client = {
      query: async (query: string, params?: unknown[]) => {
        if (params) paramsSeen.push(params);
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (query.includes("SELECT id FROM soul_injector_plugin.debug_cases")) return { rows: [{ id: input.caseId }], rowCount: 1 };
        if (query.includes("FROM soul_injector_plugin.target_config_revisions")) return { rows: [{ id: targetConfigId }], rowCount: 1 };
        if (query.includes("FROM soul_injector_plugin.debug_artifacts")) return { rows: [{ id: artifactId }], rowCount: 1 };
        if (query.includes("INSERT INTO soul_injector_plugin.debug_sessions")) return { rows: [row], rowCount: 1 };
        throw new Error(`unexpected query: ${query}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ connect: async () => client } as unknown as Pool);
    const result = await repository.createDebugSession({
      ...input,
      targetConfigId,
      targetConfigRevision: 2,
      targetId: "fixture",
      artifactId,
    });
    expect(result).toMatchObject({ targetConfigId, targetConfigRevision: 2, targetId: "fixture", artifactId });
    const insertParams = paramsSeen.find((params) => params.length === 13);
    expect(insertParams?.slice(8)).toEqual([targetConfigId, 2, "fixture", artifactId, input.startedBy]);
  });
});

describe("SoulInjector installation session scope", () => {
  test("applies installation scope before returning session lists", async () => {
    const calls: { query: string; params?: unknown[] }[] = [];
    const pool = {
      query: async (query: string, params?: unknown[]) => {
        calls.push({ query, params });
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const repository = new SoulInjectorRepository(pool);
    await expect(repository.listDebugSessions("installation-1", "project-1", 8)).resolves.toEqual([]);
    expect(calls[0]?.query).toContain("s.installation_id = $1");
    expect(calls[0]?.params).toEqual(["installation-1", "project-1", 8]);
  });

  test("loads the most recent observations while preserving chronological order", async () => {
    const calls: { query: string; params?: unknown[] }[] = [];
    const pool = {
      query: async (query: string, params?: unknown[]) => {
        calls.push({ query, params });
        return {
          rows: [
            { id: "observation-new", session_id: "session-1", event_ref: "event-new", source: "device", kind: "debug.status", structured_data: { state: "failed" }, artifact_id: null, created_at: new Date(2_000) },
            { id: "observation-old", session_id: "session-1", event_ref: "event-old", source: "device", kind: "debug.status", structured_data: { state: "running" }, artifact_id: null, created_at: new Date(1_000) },
          ],
          rowCount: 2,
        };
      },
    } as unknown as Pool;
    const result = await new SoulInjectorRepository(pool).listDebugObservations("session-1", "installation-1", "project-1", 2);
    expect(calls[0]?.query).toContain("ORDER BY o.created_at DESC, o.id DESC");
    expect(calls[0]?.params).toEqual(["session-1", "installation-1", "project-1", 2]);
    expect(result.map((item) => item.id)).toEqual(["observation-old", "observation-new"]);
  });
});

describe("SoulInjector device session state", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000016",
    case_id: "00000000-0000-4000-8000-000000000017",
    installation_id: "00000000-0000-4000-8000-000000000022",
    soulcloud_device_ref: "00000000-0000-4000-8000-000000000018",
    execution_ref: "00000000-0000-4000-8000-000000000019",
    state: "active",
    plugin_version: "0.1.0",
    manifest_hash: "b".repeat(64),
    device_firmware_version: null,
    started_by: "00000000-0000-4000-8000-000000000020",
    controller: null,
    started_at: new Date(0),
    ended_at: null,
  };

  function repositoryForState(current: Record<string, unknown>, updated: Record<string, unknown> = current) {
    const queries: string[] = [];
    const client = {
      query: async (query: string) => {
        queries.push(query);
        if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (query.includes("SELECT s.* FROM soul_injector_plugin.debug_sessions")) return { rows: [current], rowCount: 1 };
        if (query.includes("UPDATE soul_injector_plugin.debug_sessions")) return { rows: [updated], rowCount: 1 };
        throw new Error(`unexpected query: ${query}`);
      },
      release: () => {},
    } as unknown as PoolClient;
    return { repository: new SoulInjectorRepository({ connect: async () => client } as unknown as Pool), queries };
  }

  test("updates a session only when the event belongs to its device", async () => {
    const updated = { ...base, state: "completed", ended_at: new Date(1) };
    const fake = repositoryForState(base, updated);
    const result = await fake.repository.updateDebugSessionState({
      installationId: base.installation_id as string,
      projectId: "00000000-0000-4000-8000-000000000021",
      sessionId: base.id,
      soulcloudDeviceRef: base.soulcloud_device_ref,
      state: "completed",
    });
    expect(result.state).toBe("completed");
    expect(fake.queries.some((query) => query.startsWith("UPDATE soul_injector_plugin.debug_sessions"))).toBe(true);
  });

  test("does not move a terminal session backwards", async () => {
    const terminal = { ...base, state: "failed", ended_at: new Date(1) };
    const fake = repositoryForState(terminal);
    const result = await fake.repository.updateDebugSessionState({
      installationId: base.installation_id as string,
      projectId: "00000000-0000-4000-8000-000000000021",
      sessionId: base.id,
      soulcloudDeviceRef: base.soulcloud_device_ref,
      state: "active",
    });
    expect(result.state).toBe("failed");
    expect(fake.queries.some((query) => query.startsWith("UPDATE soul_injector_plugin.debug_sessions"))).toBe(false);
  });

  test("aborts only the session matching execution and device scope", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const updated = { ...base, state: "failed", ended_at: new Date(1) };
    const client = {
      query: async (query: string, params?: unknown[]) => {
        queries.push({ query, params });
        return query.includes("UPDATE soul_injector_plugin.debug_sessions")
          ? { rows: [updated], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ query: client.query, connect: async () => client } as unknown as Pool);
    await expect(repository.abortDebugSession(base.id as string, base.execution_ref as string, base.installation_id as string, "00000000-0000-4000-8000-000000000021", base.soulcloud_device_ref as string)).resolves.toMatchObject({ state: "failed" });
    const update = queries.find((item) => item.query.startsWith("UPDATE soul_injector_plugin.debug_sessions"));
    expect(update?.params).toEqual([base.id, base.execution_ref, base.installation_id, base.soulcloud_device_ref, "00000000-0000-4000-8000-000000000021"]);
    expect(update?.query).toContain("s.execution_ref = $2");
    expect(update?.query).toContain("s.soulcloud_device_ref = $4");
  });

  test("can abort by the unique execution scope when the session ID is unavailable", async () => {
    const queries: { query: string; params?: unknown[] }[] = [];
    const updated = { ...base, state: "failed", ended_at: new Date(1) };
    const client = {
      query: async (query: string, params?: unknown[]) => {
        queries.push({ query, params });
        return query.includes("UPDATE soul_injector_plugin.debug_sessions")
          ? { rows: [updated], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const repository = new SoulInjectorRepository({ query: client.query, connect: async () => client } as unknown as Pool);
    await expect(repository.abortDebugSession(null, base.execution_ref as string, base.installation_id as string, "00000000-0000-4000-8000-000000000021", base.soulcloud_device_ref as string)).resolves.toMatchObject({ state: "failed" });
    const update = queries.find((item) => item.query.startsWith("UPDATE soul_injector_plugin.debug_sessions"));
    expect(update?.params).toEqual([null, base.execution_ref, base.installation_id, base.soulcloud_device_ref, "00000000-0000-4000-8000-000000000021"]);
    expect(update?.query).toContain("$1::uuid IS NULL OR s.id = $1::uuid");
  });
});
