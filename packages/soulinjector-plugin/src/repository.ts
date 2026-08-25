import { createHash, randomUUID } from "node:crypto";
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

export interface StoreArtifactChunkInput {
  installationId: string;
  projectId: string;
  userId: string;
  uploadId: string;
  kind: DebugArtifactKind;
  filename: string;
  contentType: string;
  totalSize: number;
  offset: number;
  final: boolean;
  chunk: Uint8Array;
}

export interface StoreArtifactChunkOutput {
  uploadId: string;
  receivedBytes: number;
  complete: boolean;
  artifactId: string | null;
  sha256: string | null;
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

CREATE TABLE IF NOT EXISTS ${schema}.artifact_uploads (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('elf', 'firmware')),
  filename varchar(128) NOT NULL,
  content_type varchar(128) NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size > 0),
  received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 hour')
);

CREATE TABLE IF NOT EXISTS ${schema}.artifact_upload_chunks (
  upload_id uuid NOT NULL REFERENCES ${schema}.artifact_uploads(id) ON DELETE CASCADE,
  offset_bytes bigint NOT NULL CHECK (offset_bytes >= 0),
  size integer NOT NULL CHECK (size > 0),
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY (upload_id, offset_bytes)
);
CREATE INDEX IF NOT EXISTS artifact_uploads_expires_idx
  ON ${schema}.artifact_uploads (expires_at);
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

  async getTargetConfig(installationId: string, revision: number): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions WHERE installation_id = $1 AND revision = $2`,
      [installationId, revision],
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

  async storeArtifactChunk(input: StoreArtifactChunkInput): Promise<StoreArtifactChunkOutput> {
    if (input.chunk.byteLength === 0 || input.chunk.byteLength > 64 * 1024) throw new Error("artifact chunk must be 1..65536 bytes");
    if (!Number.isSafeInteger(input.totalSize) || input.totalSize <= 0 || input.totalSize > 64 * 1024 * 1024) throw new Error("invalid artifact total size");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset + input.chunk.byteLength > input.totalSize) throw new Error("invalid artifact chunk offset");
    if (!input.final && input.offset + input.chunk.byteLength === input.totalSize) throw new Error("a non-final artifact chunk must leave bytes for a final chunk");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Cleanup is handled by the bounded maintenance job. On the upload hot
      // path only remove a stale row for this ID, keeping the transaction
      // indexed and independent of the total number of expired uploads.
      await client.query(`DELETE FROM ${schema}.artifact_uploads WHERE id = $1 AND expires_at < CURRENT_TIMESTAMP`, [input.uploadId]);
      await client.query(
        `INSERT INTO ${schema}.artifact_uploads
          (id, installation_id, project_id, kind, filename, content_type, expected_size, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [input.uploadId, input.installationId, input.projectId, input.kind, input.filename, input.contentType, input.totalSize, input.userId],
      );
      const uploadResult = await client.query<QueryResultRow>(
        `SELECT * FROM ${schema}.artifact_uploads WHERE id = $1 FOR UPDATE`,
        [input.uploadId],
      );
      const upload = uploadResult.rows[0];
      if (!upload) throw new Error("artifact upload disappeared");
      if (asString(upload.installation_id, "installation id") !== input.installationId || asString(upload.project_id, "project id") !== input.projectId || asString(upload.created_by, "artifact uploader") !== input.userId || upload.kind !== input.kind || asString(upload.filename, "artifact filename") !== input.filename || asString(upload.content_type, "artifact content type") !== input.contentType || Number(upload.expected_size) !== input.totalSize) {
        throw new Error("artifact upload metadata changed");
      }
      const receivedBytes = Number(upload.received_size);
      if (input.offset !== receivedBytes) {
        const existing = await client.query<QueryResultRow>(
          `SELECT size, sha256 FROM ${schema}.artifact_upload_chunks WHERE upload_id = $1 AND offset_bytes = $2`,
          [input.uploadId, input.offset],
        );
        const digest = createSha256(input.chunk);
        if (input.offset < receivedBytes && existing.rows[0] && Number(existing.rows[0].size) === input.chunk.byteLength && asString(existing.rows[0].sha256, "artifact chunk hash").trim() === digest) {
          await client.query("COMMIT");
          return { uploadId: input.uploadId, receivedBytes, complete: false, artifactId: null, sha256: null };
        }
        throw new Error("artifact chunks must arrive in order");
      }
      const digest = createSha256(input.chunk);
      await client.query(
        `INSERT INTO ${schema}.artifact_upload_chunks (upload_id, offset_bytes, size, sha256, content) VALUES ($1, $2, $3, $4, $5)`,
        [input.uploadId, input.offset, input.chunk.byteLength, digest, Buffer.isBuffer(input.chunk) ? input.chunk : Buffer.from(input.chunk)],
      );
      const nextReceivedBytes = receivedBytes + input.chunk.byteLength;
      await client.query(`UPDATE ${schema}.artifact_uploads SET received_size = $2 WHERE id = $1`, [input.uploadId, nextReceivedBytes]);
      if (!input.final) {
        await client.query("COMMIT");
        return { uploadId: input.uploadId, receivedBytes: nextReceivedBytes, complete: false, artifactId: null, sha256: null };
      }
      if (nextReceivedBytes !== input.totalSize) throw new Error("final artifact chunk does not complete the declared size");
      const chunks = await client.query<QueryResultRow>(
        `SELECT offset_bytes, size, content FROM ${schema}.artifact_upload_chunks WHERE upload_id = $1 ORDER BY offset_bytes ASC`,
        [input.uploadId],
      );
      const parts: Buffer[] = [];
      let expectedOffset = 0;
      for (const row of chunks.rows) {
        if (Number(row.offset_bytes) !== expectedOffset || !Buffer.isBuffer(row.content) || Number(row.size) !== row.content.byteLength) throw new Error("artifact upload chunks are not contiguous");
        parts.push(row.content);
        expectedOffset += row.content.byteLength;
      }
      const bytes = Buffer.concat(parts, input.totalSize);
      const artifact = validateArtifact({ kind: input.kind, filename: input.filename, contentType: input.contentType, bytes });
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO ${schema}.debug_artifacts
          (id, installation_id, project_id, kind, filename, content_type, size, sha256, content, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [artifactId, input.installationId, input.projectId, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, bytes, input.userId],
      );
      await client.query(`DELETE FROM ${schema}.artifact_uploads WHERE id = $1`, [input.uploadId]);
      await client.query("COMMIT");
      return { uploadId: input.uploadId, receivedBytes: nextReceivedBytes, complete: true, artifactId, sha256: artifact.sha256 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  async purgeExpiredArtifactUploads(batchSize = 256): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) throw new RangeError("artifact upload cleanup batch size must be between 1 and 10000");
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT id FROM ${schema}.artifact_uploads
         WHERE expires_at < CURRENT_TIMESTAMP
         ORDER BY expires_at ASC, id ASC
         LIMIT $1
       )
       DELETE FROM ${schema}.artifact_uploads uploads
       USING expired
       WHERE uploads.id = expired.id`,
      [batchSize],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
