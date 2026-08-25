import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { parseTargetConfigYaml, targetConfigHash, type TargetConfig } from "./target-config";
import { validateArtifact, type DebugArtifactKind, type ValidatedArtifact } from "./artifact";

const schema = "soul_injector_plugin";

export interface TargetConfigRecord {
  id: string;
  installationId: string;
  projectId: string;
  revision: number;
  yaml: string;
  config: TargetConfig;
  sha256: string;
  createdBy: string;
  createdAt: string;
}

export interface DebugArtifactRecord {
  id: string;
  installationId: string;
  projectId: string;
  kind: DebugArtifactKind;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
}

export interface SaveTargetConfigInput {
  installationId: string;
  projectId: string;
  createdBy: string;
  yaml: string;
}

export interface SaveArtifactInput {
  installationId: string;
  projectId: string;
  createdBy: string;
  kind: DebugArtifactKind;
  filename: string;
  contentType?: string;
  bytes: Uint8Array;
}

const MIGRATION = `
CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE IF NOT EXISTS ${schema}.target_config_heads (
  installation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  latest_revision integer NOT NULL CHECK (latest_revision > 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ${schema}.target_config_revisions (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  yaml_content text NOT NULL,
  config_json jsonb NOT NULL,
  sha256 char(64) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (installation_id, revision)
);
CREATE INDEX IF NOT EXISTS target_config_revisions_installation_created_idx
  ON ${schema}.target_config_revisions (installation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ${schema}.debug_artifacts (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('elf', 'firmware')),
  filename varchar(128) NOT NULL,
  content_type varchar(128) NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS debug_artifacts_installation_created_idx
  ON ${schema}.debug_artifacts (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS debug_artifacts_installation_sha256_idx
  ON ${schema}.debug_artifacts (installation_id, sha256);
`;

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`private plugin database returned invalid ${field}`);
  return value;
}

function asRecord(row: QueryResultRow): TargetConfigRecord {
  const config = parseTargetConfigYaml(JSON.stringify(row.config_json));
  return {
    id: asString(row.id, "target config id"),
    installationId: asString(row.installation_id, "installation id"),
    projectId: asString(row.project_id, "project id"),
    revision: Number(row.revision),
    yaml: asString(row.yaml_content, "target config YAML"),
    config,
    sha256: asString(row.sha256, "target config hash").trim(),
    createdBy: asString(row.created_by, "target config creator"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function asArtifactRecord(row: QueryResultRow): DebugArtifactRecord {
  return {
    id: asString(row.id, "artifact id"),
    installationId: asString(row.installation_id, "installation id"),
    projectId: asString(row.project_id, "project id"),
    kind: row.kind === "elf" || row.kind === "firmware" ? row.kind : (() => { throw new Error("private plugin database returned invalid artifact kind"); })(),
    filename: asString(row.filename, "artifact filename"),
    contentType: asString(row.content_type, "artifact content type"),
    size: Number(row.size),
    sha256: asString(row.sha256, "artifact hash").trim(),
    createdBy: asString(row.created_by, "artifact creator"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

export class SoulInjectorRepository {
  constructor(readonly pool: Pool) {}

  static fromEnv(): SoulInjectorRepository {
    const url = process.env.SOULINJECTOR_PLUGIN_DATABASE_URL;
    if (!url) throw new Error("SOULINJECTOR_PLUGIN_DATABASE_URL is required; the plugin must not use Soulcloud's core DATABASE_URL");
    const max = Number(process.env.SOULINJECTOR_PLUGIN_DB_POOL_SIZE ?? "4");
    if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error("SOULINJECTOR_PLUGIN_DB_POOL_SIZE must be between 1 and 32");
    return new SoulInjectorRepository(new Pool({ connectionString: url, max }));
  }

  async migrate(): Promise<void> {
    await this.pool.query("BEGIN");
    try {
      await this.pool.query(MIGRATION);
      await this.pool.query("COMMIT");
    } catch (error) {
      await this.pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async saveTargetConfig(input: SaveTargetConfigInput): Promise<TargetConfigRecord> {
    const config = parseTargetConfigYaml(input.yaml);
    const hash = await targetConfigHash(config);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${schema}.target_config_heads (installation_id, project_id, latest_revision)
         VALUES ($1, $2, 1) ON CONFLICT (installation_id) DO NOTHING`,
        [input.installationId, input.projectId],
      );
      const head = await client.query<{ latest_revision: number; project_id: string }>(
        `SELECT latest_revision, project_id FROM ${schema}.target_config_heads WHERE installation_id = $1 FOR UPDATE`,
        [input.installationId],
      );
      const row = head.rows[0];
      if (!row) throw new Error("target config head disappeared during save");
      if (row.project_id !== input.projectId) throw new Error("target config installation belongs to another project");
      const latest = await client.query<QueryResultRow>(
        `SELECT * FROM ${schema}.target_config_revisions WHERE installation_id = $1 ORDER BY revision DESC LIMIT 1`,
        [input.installationId],
      );
      if (latest.rows[0] && asString(latest.rows[0].sha256, "target config hash").trim() === hash) {
        await client.query("COMMIT");
        return asRecord(latest.rows[0]);
      }
      const revision = Number(row.latest_revision);
      const id = randomUUID();
      const inserted = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.target_config_revisions
          (id, installation_id, project_id, revision, yaml_content, config_json, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [id, input.installationId, input.projectId, revision, input.yaml, JSON.stringify(config), hash, input.createdBy],
      );
      await client.query(
        `UPDATE ${schema}.target_config_heads SET latest_revision = $2, updated_at = CURRENT_TIMESTAMP WHERE installation_id = $1`,
        [input.installationId, revision + 1],
      );
      await client.query("COMMIT");
      return asRecord(inserted.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLatestTargetConfig(installationId: string): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions WHERE installation_id = $1 ORDER BY revision DESC LIMIT 1`,
      [installationId],
    );
    return result.rows[0] ? asRecord(result.rows[0]) : null;
  }

  async storeArtifact(input: SaveArtifactInput): Promise<DebugArtifactRecord> {
    const artifact = validateArtifact(input);
    const id = randomUUID();
    const result = await this.pool.query<QueryResultRow>(
      `INSERT INTO ${schema}.debug_artifacts
        (id, installation_id, project_id, kind, filename, content_type, size, sha256, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, installation_id, project_id, kind, filename, content_type, size, sha256, created_by, created_at`,
      [id, input.installationId, input.projectId, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, Buffer.isBuffer(artifact.bytes) ? artifact.bytes : Buffer.from(artifact.bytes), input.createdBy],
    );
    return asArtifactRecord(result.rows[0]!);
  }

  async getArtifact(id: string): Promise<(DebugArtifactRecord & { bytes: Uint8Array }) | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.debug_artifacts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const record = asArtifactRecord(row);
    if (!Buffer.isBuffer(row.content)) throw new Error("private plugin database returned invalid artifact bytes");
    return { ...record, bytes: new Uint8Array(row.content.buffer, row.content.byteOffset, row.content.byteLength) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
