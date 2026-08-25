import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { parseTargetConfigYaml, targetConfigHash, type TargetConfig } from "./target-config";
import { validateArtifact, validateArtifactMetadata, type DebugArtifactKind, type ValidatedArtifact } from "./artifact";

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
  metadata: Record<string, string | number>;
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

export interface ReadArtifactChunkOutput {
  artifactId: string;
  offset: number;
  totalSize: number;
  sha256: string;
  chunk: Uint8Array;
  final: boolean;
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

export class DebugSessionNotAvailableError extends Error {
  constructor() {
    super("debug session is not available to this installation/project/device");
    this.name = "DebugSessionNotAvailableError";
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
  installationId: string;
  soulcloudDeviceRef: string;
  executionRef: string | null;
  state: DebugSessionState;
  pluginVersion: string;
  manifestHash: string;
  deviceFirmwareVersion: string | null;
  targetConfigId: string | null;
  targetConfigRevision: number | null;
  targetId: string | null;
  artifactId: string | null;
  startedBy: string;
  controller: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface CreateDebugSessionInput {
  installationId: string;
  projectId: string;
  caseId: string;
  soulcloudDeviceRef: string;
  executionRef?: string | null;
  pluginVersion: string;
  manifestHash: string;
  deviceFirmwareVersion?: string | null;
  targetConfigId?: string | null;
  targetConfigRevision?: number | null;
  targetId?: string | null;
  artifactId?: string | null;
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
  installationId: string;
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

export interface UpdateDebugSessionStateInput {
  installationId: string;
  projectId: string;
  sessionId: string;
  soulcloudDeviceRef: string;
  state: Exclude<DebugSessionState, "paused">;
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
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS debug_artifacts_installation_created_idx
  ON ${schema}.debug_artifacts (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS debug_artifacts_installation_project_created_idx
  ON ${schema}.debug_artifacts (installation_id, project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS debug_artifacts_installation_sha256_idx
  ON ${schema}.debug_artifacts (installation_id, sha256);

ALTER TABLE ${schema}.debug_artifacts
  ADD COLUMN IF NOT EXISTS case_id uuid,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
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
  installation_id uuid,
  soulcloud_device_ref uuid NOT NULL,
  execution_ref uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
  plugin_version varchar(128) NOT NULL,
  manifest_hash char(64) NOT NULL CHECK (manifest_hash ~ '^[0-9a-fA-F]{64}$'),
  device_firmware_version varchar(256),
  target_config_id uuid,
  target_config_revision integer CHECK (target_config_revision IS NULL OR target_config_revision > 0),
  target_id varchar(64),
  artifact_id uuid,
  started_by uuid NOT NULL,
  controller uuid,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz
);
ALTER TABLE ${schema}.debug_sessions
  ADD COLUMN IF NOT EXISTS installation_id uuid,
  ADD COLUMN IF NOT EXISTS target_config_id uuid,
  ADD COLUMN IF NOT EXISTS target_config_revision integer,
  ADD COLUMN IF NOT EXISTS target_id varchar(64),
  ADD COLUMN IF NOT EXISTS artifact_id uuid;
CREATE INDEX IF NOT EXISTS debug_sessions_case_started_idx
  ON ${schema}.debug_sessions (case_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS debug_sessions_installation_started_idx
  ON ${schema}.debug_sessions (installation_id, started_at DESC, id DESC);
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
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("private plugin database returned invalid artifact metadata");
  for (const value of Object.values(metadata as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "number") throw new Error("private plugin database returned invalid artifact metadata");
  }
  return {
    id: asString(row.id, "artifact id"),
    installationId: asString(row.installation_id, "installation id"),
    projectId: asString(row.project_id, "project id"),
    kind: row.kind === "elf" || row.kind === "firmware" ? row.kind : (() => { throw new Error("private plugin database returned invalid artifact kind"); })(),
    filename: asString(row.filename, "artifact filename"),
    contentType: asString(row.content_type, "artifact content type"),
    size: Number(row.size),
    sha256: asString(row.sha256, "artifact hash").trim(),
    metadata: metadata as Record<string, string | number>,
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
    installationId: asString(row.installation_id, "session installation id"),
    soulcloudDeviceRef: asString(row.soulcloud_device_ref, "Soulcloud Device reference"),
    executionRef: optionalString(row.execution_ref, "execution reference"),
    state: asSessionState(row.state),
    pluginVersion: asString(row.plugin_version, "plugin version"),
    manifestHash: asString(row.manifest_hash, "manifest hash").trim().toLowerCase(),
    deviceFirmwareVersion: optionalString(row.device_firmware_version, "device firmware version"),
    targetConfigId: optionalString(row.target_config_id, "target configuration id"),
    targetConfigRevision: row.target_config_revision === null || row.target_config_revision === undefined ? null : Number(row.target_config_revision),
    targetId: optionalString(row.target_id, "target id"),
    artifactId: optionalString(row.artifact_id, "artifact id"),
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

  async getLatestTargetConfig(installationId: string, projectId: string): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [installationId, projectId],
    );
    return result.rows[0] ? asRecord(result.rows[0]) : null;
  }

  async getTargetConfig(installationId: string, projectId: string, revision: number): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2 AND revision = $3`,
      [installationId, projectId, revision],
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
        (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, metadata, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, installation_id, project_id, kind, filename, content_type, size, sha256, metadata, created_by, created_at`,
      [id, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, artifact.metadata, Buffer.isBuffer(artifact.bytes) ? artifact.bytes : Buffer.from(artifact.bytes), input.createdBy],
    );
    return asArtifactRecord(result.rows[0]!);
  }

  async storeArtifactChunk(input: StoreArtifactChunkInput): Promise<StoreArtifactChunkOutput> {
    if (!UUID.test(input.uploadId)) throw new Error("artifact upload ID must be a UUID");
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
      // Keep the final validation bounded in the plugin process. A PostgreSQL
      // cursor fetches only a small batch of chunk bodies, while the final
      // bytea is assembled inside PostgreSQL below. This avoids retaining a
      // second 64 MiB copy in Bun for the largest supported artifact.
      const cursorName = `soulinjector_artifact_${randomUUID().replaceAll("-", "")}`;
      await client.query(
        `DECLARE ${cursorName} NO SCROLL CURSOR FOR
         SELECT offset_bytes, size, sha256, content
         FROM ${schema}.artifact_upload_chunks
         WHERE upload_id = '${input.uploadId}'::uuid
         ORDER BY offset_bytes ASC`,
      );
      const hash = createHash("sha256");
      let expectedOffset = 0;
      const header = input.kind === "elf" ? new Uint8Array(Math.min(64, input.totalSize)) : undefined;
      let headerBytes = 0;
      try {
        while (true) {
          const batch = await client.query<QueryResultRow>(`FETCH FORWARD 8 FROM ${cursorName}`);
          if (batch.rows.length === 0) break;
          for (const row of batch.rows) {
            const content = row.content;
            if (!Buffer.isBuffer(content) || Number(row.offset_bytes) !== expectedOffset || Number(row.size) !== content.byteLength) {
              throw new Error("artifact upload chunks are not contiguous");
            }
            const chunkHash = createHash("sha256").update(content).digest("hex");
            if (asString(row.sha256, "artifact chunk hash").trim().toLowerCase() !== chunkHash) {
              throw new Error("artifact upload chunk hash mismatch");
            }
            if (header && headerBytes < header.byteLength) {
              const copyLength = Math.min(content.byteLength, header.byteLength - headerBytes);
              header.set(content.subarray(0, copyLength), headerBytes);
              headerBytes += copyLength;
            }
            hash.update(content);
            expectedOffset += content.byteLength;
          }
        }
      } finally {
        await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
      }
      if (expectedOffset !== input.totalSize) throw new Error("final artifact chunks do not match the declared size");
      const artifact = validateArtifactMetadata({
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        header: header ?? new Uint8Array(),
        size: input.totalSize,
        sha256: hash.digest("hex"),
      });
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO ${schema}.debug_artifacts
          (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, metadata, content, created_by)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                string_agg(content, ''::bytea ORDER BY offset_bytes), $11
         FROM ${schema}.artifact_upload_chunks
         WHERE upload_id = $12`,
        [artifactId, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, artifact.metadata, input.userId, input.uploadId],
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

  async readArtifactChunk(id: string, installationId: string, projectId: string, offset: number, length: number): Promise<ReadArtifactChunkOutput | null> {
    if (!UUID.test(id) || !UUID.test(installationId) || !UUID.test(projectId)) throw new RangeError("artifact scope must be UUIDs");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 64 * 1024 * 1024) throw new RangeError("artifact offset is invalid");
    if (!Number.isSafeInteger(length) || length < 1 || length > 64 * 1024) throw new RangeError("artifact chunk length is invalid");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, size, sha256, substring(content FROM $4 FOR $5) AS chunk
       FROM ${schema}.debug_artifacts
       WHERE id = $1 AND installation_id = $2 AND project_id = $3`,
      [id, installationId, projectId, offset + 1, length],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!Buffer.isBuffer(row.chunk)) throw new Error("private plugin database returned invalid artifact chunk");
    const totalSize = Number(row.size);
    if (!Number.isSafeInteger(totalSize) || totalSize < 1 || offset >= totalSize || row.chunk.byteLength < 1 || row.chunk.byteLength > length) {
      throw new Error("private plugin database returned an invalid artifact chunk");
    }
    return {
      artifactId: asString(row.id, "artifact id"),
      offset,
      totalSize,
      sha256: asString(row.sha256, "artifact hash").trim().toLowerCase(),
      chunk: new Uint8Array(row.chunk.buffer, row.chunk.byteOffset, row.chunk.byteLength),
      final: offset + row.chunk.byteLength === totalSize,
    };
  }

  async listArtifacts(installationId: string, projectId: string): Promise<DebugArtifactRecord[]> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, installation_id, project_id, kind, filename, content_type, size, sha256, metadata, created_by, created_at
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

  async listDebugReports(projectId: string, limit = 64): Promise<DebugReportRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("report limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT r.* FROM ${schema}.debug_reports r
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE c.project_id = $1
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(asReportRecord);
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
    const targetConfigId = input.targetConfigId === null || input.targetConfigId === undefined ? null : input.targetConfigId;
    if (targetConfigId !== null && !UUID.test(targetConfigId)) throw new RangeError("target configuration id must be a UUID");
    const targetConfigRevision = input.targetConfigRevision === null || input.targetConfigRevision === undefined ? null : input.targetConfigRevision;
    if (targetConfigRevision !== null && (!Number.isSafeInteger(targetConfigRevision) || targetConfigRevision < 1)) throw new RangeError("target configuration revision must be a positive safe integer");
    const targetId = input.targetId === null || input.targetId === undefined ? null : boundedText(input.targetId, "target id", 64);
    const artifactId = input.artifactId === null || input.artifactId === undefined ? null : input.artifactId;
    if (artifactId !== null && !UUID.test(artifactId)) throw new RangeError("artifact id must be a UUID");
    if ((targetConfigId === null) !== (targetConfigRevision === null) || (targetConfigRevision === null) !== (targetId === null)) throw new RangeError("target configuration id, revision and target id must be provided together");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2 FOR UPDATE`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("debug case is not available to this project");
      if (targetConfigId !== null) {
        const targetResult = await client.query(
          `SELECT id FROM ${schema}.target_config_revisions
           WHERE id = $1 AND installation_id = $2 AND project_id = $3 AND revision = $4`,
          [targetConfigId, input.installationId, input.projectId, targetConfigRevision],
        );
        if (!targetResult.rows[0]) throw new Error("target configuration revision is not available to this installation");
      }
      if (artifactId !== null) {
        const artifactResult = await client.query(
          `SELECT id FROM ${schema}.debug_artifacts
           WHERE id = $1 AND installation_id = $2 AND project_id = $3
             AND (case_id = $4 OR case_id IS NULL)`,
          [artifactId, input.installationId, input.projectId, input.caseId],
        );
        if (!artifactResult.rows[0]) throw new Error("debug artifact is not available to this session");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_sessions
         (id, case_id, installation_id, soulcloud_device_ref, execution_ref, plugin_version, manifest_hash, device_firmware_version,
          target_config_id, target_config_revision, target_id, artifact_id, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (execution_ref) WHERE execution_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [randomUUID(), input.caseId, input.installationId, input.soulcloudDeviceRef, input.executionRef ?? null, pluginVersion, input.manifestHash.toLowerCase(), deviceFirmwareVersion, targetConfigId, targetConfigRevision, targetId, artifactId, input.startedBy],
      );
      if (!result.rows[0] && input.executionRef) {
        const existingResult = await client.query<QueryResultRow>(
          `SELECT s.* FROM ${schema}.debug_sessions s
           JOIN ${schema}.debug_cases c ON c.id = s.case_id
           WHERE s.execution_ref = $1 AND c.project_id = $2 AND s.installation_id = $3
           FOR UPDATE`,
          [input.executionRef, input.projectId, input.installationId],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error("debug session disappeared after idempotent insert");
        const sameSession = existing.case_id === input.caseId
          && existing.installation_id === input.installationId
          && existing.soulcloud_device_ref === input.soulcloudDeviceRef
          && existing.plugin_version === pluginVersion
          && String(existing.manifest_hash).trim().toLowerCase() === input.manifestHash.toLowerCase()
          && (existing.device_firmware_version ?? null) === deviceFirmwareVersion
          && (existing.target_config_id ?? null) === targetConfigId
          && (existing.target_config_revision === null || existing.target_config_revision === undefined ? null : Number(existing.target_config_revision)) === targetConfigRevision
          && (existing.target_id ?? null) === targetId
          && (existing.artifact_id ?? null) === artifactId
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

  async finishDebugSession(id: string, installationId: string, projectId: string, state: Exclude<DebugSessionState, "active" | "paused">): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_sessions s
       SET state = $4, ended_at = COALESCE(s.ended_at, CURRENT_TIMESTAMP)
       FROM ${schema}.debug_cases c
       WHERE s.id = $1 AND s.installation_id = $2 AND s.case_id = c.id AND c.project_id = $3
       RETURNING s.*`,
      [id, installationId, projectId, state],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  /** Mark a bootstrap-created session failed without issuing any device command. */
  async abortDebugSession(
    id: string | null,
    executionRef: string,
    installationId: string,
    projectId: string,
    soulcloudDeviceRef: string,
  ): Promise<DebugSessionRecord | null> {
    if ((id !== null && !UUID.test(id)) || !UUID.test(executionRef) || !UUID.test(soulcloudDeviceRef)) return null;
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_sessions s
       SET state = CASE WHEN s.state IN ('completed', 'failed', 'cancelled') THEN s.state ELSE 'failed' END,
           ended_at = CASE WHEN s.state IN ('completed', 'failed', 'cancelled') THEN s.ended_at ELSE COALESCE(s.ended_at, CURRENT_TIMESTAMP) END
       FROM ${schema}.debug_cases c
       WHERE ($1::uuid IS NULL OR s.id = $1::uuid) AND s.execution_ref = $2 AND s.installation_id = $3
         AND s.soulcloud_device_ref = $4 AND s.case_id = c.id AND c.project_id = $5
       RETURNING s.*`,
      [id, executionRef, installationId, soulcloudDeviceRef, projectId],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async updateDebugSessionState(input: UpdateDebugSessionStateInput): Promise<DebugSessionRecord> {
    if (!UUID.test(input.sessionId)) throw new RangeError("session id must be a UUID");
    if (!UUID.test(input.soulcloudDeviceRef)) throw new RangeError("Soulcloud Device reference must be a UUID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<QueryResultRow>(
        `SELECT s.* FROM ${schema}.debug_sessions s
         JOIN ${schema}.debug_cases c ON c.id = s.case_id
         WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3 AND s.soulcloud_device_ref = $4
         FOR UPDATE`,
        [input.sessionId, input.installationId, input.projectId, input.soulcloudDeviceRef],
      );
      const current = currentResult.rows[0];
      if (!current) throw new DebugSessionNotAvailableError();
      const currentState = asSessionState(current.state);
      if (currentState === "completed" || currentState === "failed" || currentState === "cancelled") {
        await client.query("COMMIT");
        return asSessionRecord(current);
      }
      const endedAt = input.state === "completed" || input.state === "failed" || input.state === "cancelled";
      const updatedResult = await client.query<QueryResultRow>(
        `UPDATE ${schema}.debug_sessions
         SET state = $4, ended_at = CASE WHEN $5::boolean THEN COALESCE(ended_at, CURRENT_TIMESTAMP) ELSE ended_at END
         WHERE id = $1 AND EXISTS (
           SELECT 1 FROM ${schema}.debug_cases c
           WHERE c.id = debug_sessions.case_id AND c.project_id = $2
         ) AND installation_id = $3 AND soulcloud_device_ref = $6
         RETURNING *`,
        [input.sessionId, input.projectId, input.installationId, input.state, endedAt, input.soulcloudDeviceRef],
      );
      if (!updatedResult.rows[0]) throw new Error("debug session disappeared while updating state");
      await client.query("COMMIT");
      return asSessionRecord(updatedResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDebugSession(id: string, installationId: string, projectId: string): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3`,
      [id, installationId, projectId],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async listDebugSessions(installationId: string, projectId: string, limit = 64): Promise<DebugSessionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("session limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE s.installation_id = $1 AND c.project_id = $2
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT $3`,
      [installationId, projectId, limit],
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
         WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3
           AND ($4::text IS NULL OR s.soulcloud_device_ref = $4)
         FOR UPDATE`,
        [input.sessionId, input.installationId, input.projectId, soulcloudDeviceRef],
      );
      if (!sessionResult.rows[0]) throw new DebugSessionNotAvailableError();
      if (input.artifactId !== null && input.artifactId !== undefined) {
        const artifactResult = await client.query(
          `SELECT id FROM ${schema}.debug_artifacts WHERE id = $1 AND installation_id = $2 AND project_id = $3`,
          [input.artifactId, input.installationId, input.projectId],
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

  async listDebugObservations(sessionId: string, installationId: string, projectId: string, limit = 128): Promise<DebugObservationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new RangeError("observation limit must be between 1 and 512");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT o.* FROM ${schema}.debug_observations o
       JOIN ${schema}.debug_sessions s ON s.id = o.session_id
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE o.session_id = $1 AND s.installation_id = $2 AND c.project_id = $3
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $4`,
      [sessionId, installationId, projectId, limit],
    );
    return result.rows.reverse().map(asObservationRecord);
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
