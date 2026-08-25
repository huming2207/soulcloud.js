import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { parseTargetConfigYaml, targetConfigHash, type TargetConfig } from "./target-config";
import { validateArtifact, type DebugArtifactKind, type ValidatedArtifact } from "./artifact";

const schema = "soul_injector_plugin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export interface TargetConfigSummary {
  configId: string;
  revision: number;
  sha256: string;
  targetCount: number;
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
  caseId?: string | null;
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
  caseId?: string | null;
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

export type DebugCaseState = "open" | "in_progress" | "resolved" | "closed";
export type DebugSessionState = "active" | "paused" | "completed" | "failed" | "cancelled";
export type DebugReportState = "draft" | "final";

export class DebugSessionConflictError extends Error {
  constructor() {
    super("execution reference is already associated with a different debug session");
    this.name = "DebugSessionConflictError";
  }
}

export interface DebugCaseRecord {
  id: string;
  projectId: string;
  targetUnitRef: string | null;
  state: DebugCaseState;
  title: string;
  createdBy: string;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDebugCaseInput {
  projectId: string;
  targetUnitRef?: string | null;
  title: string;
  createdBy: string;
}

export interface DebugSessionRecord {
  id: string;
  caseId: string;
  soulcloudDeviceRef: string;
  executionRef: string | null;
  state: DebugSessionState;
  pluginVersion: string;
  manifestHash: string;
  deviceFirmwareVersion: string | null;
  startedBy: string;
  controller: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface CreateDebugSessionInput {
  projectId: string;
  caseId: string;
  soulcloudDeviceRef: string;
  executionRef?: string | null;
  pluginVersion: string;
  manifestHash: string;
  deviceFirmwareVersion?: string | null;
  startedBy: string;
}

export interface DebugObservationRecord {
  id: string;
  sessionId: string;
  eventRef: string | null;
  source: string;
  kind: string;
  structuredData: unknown;
  artifactId: string | null;
  createdAt: string;
}

export interface AppendDebugObservationInput {
  projectId: string;
  sessionId: string;
  /** When present, the session must belong to this Soulcloud Device. */
  soulcloudDeviceRef?: string | null;
  eventRef?: string | null;
  source: string;
  kind: string;
  structuredData: unknown;
  artifactId?: string | null;
}

export interface DebugReportRecord {
  id: string;
  caseId: string;
  state: DebugReportState;
  title: string;
  currentRevision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DebugReportRevisionRecord {
  id: string;
  reportId: string;
  revision: number;
  content: string;
  contentSha256: string;
  metadata: unknown;
  createdBy: string;
  createdAt: string;
}

export interface CreateDebugReportInput {
  projectId: string;
  caseId: string;
  title: string;
  createdBy: string;
  content?: string;
  metadata?: unknown;
}

export interface AppendDebugReportRevisionInput {
  projectId: string;
  reportId: string;
  createdBy: string;
  content: string;
  metadata?: unknown;
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

ALTER TABLE ${schema}.debug_artifacts
  ADD COLUMN IF NOT EXISTS case_id uuid;
CREATE INDEX IF NOT EXISTS debug_artifacts_case_created_idx
  ON ${schema}.debug_artifacts (case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ${schema}.debug_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  target_unit_ref varchar(256),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'resolved', 'closed')),
  title varchar(256) NOT NULL,
  created_by uuid NOT NULL,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS debug_cases_project_updated_idx
  ON ${schema}.debug_cases (project_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ${schema}.debug_sessions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES ${schema}.debug_cases(id) ON DELETE CASCADE,
  soulcloud_device_ref uuid NOT NULL,
  execution_ref uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
  plugin_version varchar(128) NOT NULL,
  manifest_hash char(64) NOT NULL CHECK (manifest_hash ~ '^[0-9a-fA-F]{64}$'),
  device_firmware_version varchar(256),
  started_by uuid NOT NULL,
  controller uuid,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS debug_sessions_case_started_idx
  ON ${schema}.debug_sessions (case_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS debug_sessions_device_started_idx
  ON ${schema}.debug_sessions (soulcloud_device_ref, started_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS debug_sessions_execution_unique
  ON ${schema}.debug_sessions (execution_ref)
  WHERE execution_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${schema}.debug_observations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES ${schema}.debug_sessions(id) ON DELETE CASCADE,
  event_ref varchar(128),
  source varchar(64) NOT NULL,
  kind varchar(128) NOT NULL,
  structured_data jsonb NOT NULL,
  artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ${schema}.debug_observations
  ADD COLUMN IF NOT EXISTS event_ref varchar(128);
CREATE INDEX IF NOT EXISTS debug_observations_session_created_idx
  ON ${schema}.debug_observations (session_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS debug_observations_session_event_unique
  ON ${schema}.debug_observations (session_id, event_ref)
  WHERE event_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${schema}.debug_reports (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES ${schema}.debug_cases(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'final')),
  title varchar(256) NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS debug_reports_case_updated_idx
  ON ${schema}.debug_reports (case_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ${schema}.debug_report_revisions (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES ${schema}.debug_reports(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  content text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-fA-F]{64}$'),
  metadata jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (report_id, revision)
);
CREATE INDEX IF NOT EXISTS debug_report_revisions_created_idx
  ON ${schema}.debug_report_revisions (report_id, revision DESC);

CREATE TABLE IF NOT EXISTS ${schema}.artifact_uploads (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  case_id uuid,
  kind text NOT NULL CHECK (kind IN ('elf', 'firmware')),
  filename varchar(128) NOT NULL,
  content_type varchar(128) NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size > 0),
  received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  completed_artifact_id uuid,
  completed_sha256 char(64),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 hour')
);

ALTER TABLE ${schema}.artifact_uploads
  ADD COLUMN IF NOT EXISTS case_id uuid,
  ADD COLUMN IF NOT EXISTS completed_artifact_id uuid,
  ADD COLUMN IF NOT EXISTS completed_sha256 char(64);

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

function asCaseState(value: unknown): DebugCaseState {
  if (value === "open" || value === "in_progress" || value === "resolved" || value === "closed") return value;
  throw new Error("private plugin database returned invalid debug case state");
}

function asSessionState(value: unknown): DebugSessionState {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error("private plugin database returned invalid debug session state");
}

function asReportState(value: unknown): DebugReportState {
  if (value === "draft" || value === "final") return value;
  throw new Error("private plugin database returned invalid debug report state");
}

function optionalString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asString(value, field);
}

function asCaseRecord(row: QueryResultRow): DebugCaseRecord {
  return {
    id: asString(row.id, "case id"),
    projectId: asString(row.project_id, "case project id"),
    targetUnitRef: optionalString(row.target_unit_ref, "target unit reference"),
    state: asCaseState(row.state),
    title: asString(row.title, "case title"),
    createdBy: asString(row.created_by, "case creator"),
    assignedTo: optionalString(row.assigned_to, "case assignee"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function asSessionRecord(row: QueryResultRow): DebugSessionRecord {
  return {
    id: asString(row.id, "session id"),
    caseId: asString(row.case_id, "session case id"),
    soulcloudDeviceRef: asString(row.soulcloud_device_ref, "Soulcloud Device reference"),
    executionRef: optionalString(row.execution_ref, "execution reference"),
    state: asSessionState(row.state),
    pluginVersion: asString(row.plugin_version, "plugin version"),
    manifestHash: asString(row.manifest_hash, "manifest hash").trim().toLowerCase(),
    deviceFirmwareVersion: optionalString(row.device_firmware_version, "device firmware version"),
    startedBy: asString(row.started_by, "session starter"),
    controller: optionalString(row.controller, "session controller"),
    startedAt: new Date(row.started_at as string | Date).toISOString(),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : new Date(row.ended_at as string | Date).toISOString(),
  };
}

function asObservationRecord(row: QueryResultRow): DebugObservationRecord {
  return {
    id: asString(row.id, "observation id"),
    sessionId: asString(row.session_id, "observation session id"),
    eventRef: optionalString(row.event_ref, "observation event reference"),
    source: asString(row.source, "observation source"),
    kind: asString(row.kind, "observation kind"),
    structuredData: row.structured_data,
    artifactId: optionalString(row.artifact_id, "observation artifact id"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function asReportRecord(row: QueryResultRow): DebugReportRecord {
  return {
    id: asString(row.id, "report id"),
    caseId: asString(row.case_id, "report case id"),
    state: asReportState(row.state),
    title: asString(row.title, "report title"),
    currentRevision: Number(row.current_revision),
    createdBy: asString(row.created_by, "report creator"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function asReportRevisionRecord(row: QueryResultRow): DebugReportRevisionRecord {
  return {
    id: asString(row.id, "report revision id"),
    reportId: asString(row.report_id, "report id"),
    revision: Number(row.revision),
    content: asString(row.content, "report content"),
    contentSha256: asString(row.content_sha256, "report content hash").trim().toLowerCase(),
    metadata: row.metadata,
    createdBy: asString(row.created_by, "report revision creator"),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function boundedText(value: string, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${field} must be non-empty and at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function jsonValue(value: unknown, field: string, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch (error) {
    throw new RangeError(`${field} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  return serialized;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(MIGRATION);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
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

  async listTargetConfigs(installationId: string, projectId: string): Promise<TargetConfigSummary[]> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, revision, sha256, jsonb_array_length(config_json->'targets') AS target_count, created_at
       FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY revision DESC
       LIMIT 64`,
      [installationId, projectId],
    );
    return result.rows.map((row) => ({
      configId: asString(row.id, "target config id"),
      revision: Number(row.revision),
      sha256: asString(row.sha256, "target config hash").trim(),
      targetCount: Number(row.target_count),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }

  async storeArtifact(input: SaveArtifactInput): Promise<DebugArtifactRecord> {
    const artifact = validateArtifact(input);
    if (input.caseId !== null && input.caseId !== undefined) {
      const caseResult = await this.pool.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("artifact case is not available to this project");
    }
    const id = randomUUID();
    const result = await this.pool.query<QueryResultRow>(
      `INSERT INTO ${schema}.debug_artifacts
        (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, installation_id, project_id, kind, filename, content_type, size, sha256, created_by, created_at`,
      [id, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, Buffer.isBuffer(artifact.bytes) ? artifact.bytes : Buffer.from(artifact.bytes), input.createdBy],
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
          (id, installation_id, project_id, case_id, kind, filename, content_type, expected_size, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [input.uploadId, input.installationId, input.projectId, input.caseId ?? null, input.kind, input.filename, input.contentType, input.totalSize, input.userId],
      );
      const uploadResult = await client.query<QueryResultRow>(
        `SELECT * FROM ${schema}.artifact_uploads WHERE id = $1 FOR UPDATE`,
        [input.uploadId],
      );
      const upload = uploadResult.rows[0];
      if (!upload) throw new Error("artifact upload disappeared");
      if (asString(upload.installation_id, "installation id") !== input.installationId || asString(upload.project_id, "project id") !== input.projectId || optionalString(upload.case_id, "case id") !== (input.caseId ?? null) || asString(upload.created_by, "artifact uploader") !== input.userId || upload.kind !== input.kind || asString(upload.filename, "artifact filename") !== input.filename || asString(upload.content_type, "artifact content type") !== input.contentType || Number(upload.expected_size) !== input.totalSize) {
        throw new Error("artifact upload metadata changed");
      }
      if (input.caseId !== null && input.caseId !== undefined) {
        const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`, [input.caseId, input.projectId]);
        if (!caseResult.rows[0]) throw new Error("artifact case is not available to this project");
      }
      if (upload.completed_artifact_id) {
        const completed = await client.query<QueryResultRow>(
          `SELECT id, sha256 FROM ${schema}.debug_artifacts WHERE id = $1`,
          [upload.completed_artifact_id],
        );
        const artifact = completed.rows[0];
        if (!artifact) throw new Error("completed artifact disappeared");
        await client.query("COMMIT");
        return {
          uploadId: input.uploadId,
          receivedBytes: Number(upload.expected_size),
          complete: true,
          artifactId: asString(artifact.id, "artifact id"),
          sha256: asString(artifact.sha256, "artifact hash").trim(),
        };
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
          (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, content, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [artifactId, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, bytes, input.userId],
      );
      await client.query(
        `UPDATE ${schema}.artifact_uploads
         SET completed_artifact_id = $2, completed_sha256 = $3
         WHERE id = $1`,
        [input.uploadId, artifactId, artifact.sha256],
      );
      await client.query(`DELETE FROM ${schema}.artifact_upload_chunks WHERE upload_id = $1`, [input.uploadId]);
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

  async listArtifacts(installationId: string, projectId: string): Promise<DebugArtifactRecord[]> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, installation_id, project_id, kind, filename, content_type, size, sha256, created_by, created_at
       FROM ${schema}.debug_artifacts
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 64`,
      [installationId, projectId],
    );
    return result.rows.map(asArtifactRecord);
  }

  async createDebugCase(input: CreateDebugCaseInput): Promise<DebugCaseRecord> {
    const title = boundedText(input.title, "case title", 256);
    const targetUnitRef = input.targetUnitRef === null || input.targetUnitRef === undefined
      ? null
      : boundedText(input.targetUnitRef, "target unit reference", 256);
    const result = await this.pool.query<QueryResultRow>(
      `INSERT INTO ${schema}.debug_cases (id, project_id, target_unit_ref, title, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), input.projectId, targetUnitRef, title, input.createdBy],
    );
    return asCaseRecord(result.rows[0]!);
  }

  async getDebugCase(id: string, projectId: string): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }

  async listDebugCases(projectId: string, limit = 64): Promise<DebugCaseRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("case limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.debug_cases
       WHERE project_id = $1
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(asCaseRecord);
  }

  async setDebugCaseState(id: string, projectId: string, state: DebugCaseState): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_cases
       SET state = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [id, projectId, state],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }

  async assignDebugCase(id: string, projectId: string, assignedTo: string | null): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_cases
       SET assigned_to = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [id, projectId, assignedTo],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }

  async createDebugSession(input: CreateDebugSessionInput): Promise<DebugSessionRecord> {
    const pluginVersion = boundedText(input.pluginVersion, "plugin version", 128);
    const deviceFirmwareVersion = input.deviceFirmwareVersion === null || input.deviceFirmwareVersion === undefined
      ? null
      : boundedText(input.deviceFirmwareVersion, "device firmware version", 256);
    if (!/^[0-9a-f]{64}$/i.test(input.manifestHash)) throw new RangeError("manifestHash must be a SHA-256 hex digest");
    if (!UUID.test(input.soulcloudDeviceRef)) throw new RangeError("Soulcloud Device reference must be a UUID");
    if (input.executionRef !== null && input.executionRef !== undefined && !UUID.test(input.executionRef)) throw new RangeError("execution reference must be a UUID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2 FOR UPDATE`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("debug case is not available to this project");
      const result = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_sessions
         (id, case_id, soulcloud_device_ref, execution_ref, plugin_version, manifest_hash, device_firmware_version, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (execution_ref) WHERE execution_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [randomUUID(), input.caseId, input.soulcloudDeviceRef, input.executionRef ?? null, pluginVersion, input.manifestHash.toLowerCase(), deviceFirmwareVersion, input.startedBy],
      );
      if (!result.rows[0] && input.executionRef) {
        const existingResult = await client.query<QueryResultRow>(
          `SELECT s.* FROM ${schema}.debug_sessions s
           JOIN ${schema}.debug_cases c ON c.id = s.case_id
           WHERE s.execution_ref = $1 AND c.project_id = $2
           FOR UPDATE`,
          [input.executionRef, input.projectId],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error("debug session disappeared after idempotent insert");
        const sameSession = existing.case_id === input.caseId
          && existing.soulcloud_device_ref === input.soulcloudDeviceRef
          && existing.plugin_version === pluginVersion
          && String(existing.manifest_hash).trim().toLowerCase() === input.manifestHash.toLowerCase()
          && (existing.device_firmware_version ?? null) === deviceFirmwareVersion
          && existing.started_by === input.startedBy;
        if (!sameSession) throw new DebugSessionConflictError();
        await client.query("COMMIT");
        return asSessionRecord(existing);
      }
      await client.query("COMMIT");
      return asSessionRecord(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishDebugSession(id: string, projectId: string, state: Exclude<DebugSessionState, "active" | "paused">): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_sessions s
       SET state = $3, ended_at = COALESCE(s.ended_at, CURRENT_TIMESTAMP)
       FROM ${schema}.debug_cases c
       WHERE s.id = $1 AND s.case_id = c.id AND c.project_id = $2
       RETURNING s.*`,
      [id, projectId, state],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async getDebugSession(id: string, projectId: string): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE s.id = $1 AND c.project_id = $2`,
      [id, projectId],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async listDebugSessions(projectId: string, limit = 64): Promise<DebugSessionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("session limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE c.project_id = $1
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(asSessionRecord);
  }

  async appendDebugObservation(input: AppendDebugObservationInput): Promise<DebugObservationRecord> {
    const source = boundedText(input.source, "observation source", 64);
    const kind = boundedText(input.kind, "observation kind", 128);
    const soulcloudDeviceRef = input.soulcloudDeviceRef === null || input.soulcloudDeviceRef === undefined
      ? null
      : boundedText(input.soulcloudDeviceRef, "Soulcloud Device reference", 256);
    const eventRef = input.eventRef === null || input.eventRef === undefined ? null : boundedText(input.eventRef, "observation event reference", 128);
    const structuredData = jsonValue(input.structuredData, "observation data", 512 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        `SELECT s.id FROM ${schema}.debug_sessions s
         JOIN ${schema}.debug_cases c ON c.id = s.case_id
         WHERE s.id = $1 AND c.project_id = $2
           AND ($3::text IS NULL OR s.soulcloud_device_ref = $3)
         FOR UPDATE`,
        [input.sessionId, input.projectId, soulcloudDeviceRef],
      );
      if (!sessionResult.rows[0]) throw new Error("debug session is not available to this project");
      if (input.artifactId !== null && input.artifactId !== undefined) {
        const artifactResult = await client.query(
          `SELECT id FROM ${schema}.debug_artifacts WHERE id = $1 AND project_id = $2`,
          [input.artifactId, input.projectId],
        );
        if (!artifactResult.rows[0]) throw new Error("observation artifact is not available to this project");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_observations (id, session_id, event_ref, source, kind, structured_data, artifact_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (session_id, event_ref) WHERE event_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [randomUUID(), input.sessionId, eventRef, source, kind, structuredData, input.artifactId ?? null],
      );
      if (!result.rows[0] && eventRef !== null) {
        const existing = await client.query<QueryResultRow>(
          `SELECT * FROM ${schema}.debug_observations WHERE session_id = $1 AND event_ref = $2`,
          [input.sessionId, eventRef],
        );
        if (!existing.rows[0]) throw new Error("debug observation disappeared after idempotent insert");
        await client.query("COMMIT");
        return asObservationRecord(existing.rows[0]);
      }
      await client.query("COMMIT");
      return asObservationRecord(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDebugObservations(sessionId: string, projectId: string, limit = 128): Promise<DebugObservationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new RangeError("observation limit must be between 1 and 512");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT o.* FROM ${schema}.debug_observations o
       JOIN ${schema}.debug_sessions s ON s.id = o.session_id
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE o.session_id = $1 AND c.project_id = $2
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT $3`,
      [sessionId, projectId, limit],
    );
    return result.rows.map(asObservationRecord);
  }

  async createDebugReport(input: CreateDebugReportInput): Promise<DebugReportRecord> {
    const title = boundedText(input.title, "report title", 256);
    const content = input.content ?? "";
    boundedText(content || "empty", "report content", 4 * 1024 * 1024);
    const metadata = jsonValue(input.metadata ?? null, "report metadata", 256 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2 FOR UPDATE`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("debug case is not available to this project");
      const reportId = randomUUID();
      const reportResult = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_reports (id, case_id, title, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [reportId, input.caseId, title, input.createdBy],
      );
      if (content.length > 0) {
        await client.query(
          `INSERT INTO ${schema}.debug_report_revisions
            (id, report_id, revision, content, content_sha256, metadata, created_by)
           VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6)`,
          [randomUUID(), reportId, content, sha256Text(content), metadata, input.createdBy],
        );
        await client.query(`UPDATE ${schema}.debug_reports SET current_revision = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reportId]);
      }
      const finalReport = await client.query<QueryResultRow>(`SELECT * FROM ${schema}.debug_reports WHERE id = $1`, [reportId]);
      await client.query("COMMIT");
      return asReportRecord(finalReport.rows[0] ?? reportResult.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendDebugReportRevision(input: AppendDebugReportRevisionInput): Promise<DebugReportRevisionRecord> {
    boundedText(input.content, "report content", 4 * 1024 * 1024);
    const metadata = jsonValue(input.metadata ?? null, "report metadata", 256 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<QueryResultRow>(
        `SELECT r.id, r.state, r.current_revision
         FROM ${schema}.debug_reports r
         JOIN ${schema}.debug_cases c ON c.id = r.case_id
         WHERE r.id = $1 AND c.project_id = $2 FOR UPDATE`,
        [input.reportId, input.projectId],
      );
      const report = reportResult.rows[0];
      if (!report) throw new Error("debug report is not available to this project");
      if (asReportState(report.state) !== "draft") throw new Error("final debug reports are immutable");
      const revision = Number(report.current_revision) + 1;
      const revisionResult = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_report_revisions
          (id, report_id, revision, content, content_sha256, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [randomUUID(), input.reportId, revision, input.content, sha256Text(input.content), metadata, input.createdBy],
      );
      await client.query(`UPDATE ${schema}.debug_reports SET current_revision = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [input.reportId, revision]);
      await client.query("COMMIT");
      return asReportRevisionRecord(revisionResult.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_reports r
       SET state = 'final', updated_at = CURRENT_TIMESTAMP
       FROM ${schema}.debug_cases c
       WHERE r.id = $1 AND r.case_id = c.id AND c.project_id = $2 AND r.state = 'draft'
       RETURNING r.*`,
      [reportId, projectId],
    );
    return result.rows[0] ? asReportRecord(result.rows[0]) : null;
  }

  async getDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT r.* FROM ${schema}.debug_reports r
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE r.id = $1 AND c.project_id = $2`,
      [reportId, projectId],
    );
    return result.rows[0] ? asReportRecord(result.rows[0]) : null;
  }

  async listDebugReportRevisions(reportId: string, projectId: string, limit = 64): Promise<DebugReportRevisionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("report revision limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT v.* FROM ${schema}.debug_report_revisions v
       JOIN ${schema}.debug_reports r ON r.id = v.report_id
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE v.report_id = $1 AND c.project_id = $2
       ORDER BY v.revision DESC
       LIMIT $3`,
      [reportId, projectId, limit],
    );
    return result.rows.map(asReportRevisionRecord);
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
