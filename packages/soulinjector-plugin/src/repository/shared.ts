// Shared types, errors and row-mapping helpers for the private plugin database.
// The SQL statements themselves live in the per-domain store modules.

import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { parseTargetConfigYaml, type TargetConfig } from "../target-config";
import type { DebugArtifactKind } from "../artifact";

export const schema = "soul_injector_plugin";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** Idempotent schema bootstrap for the plugin-private database. */
export const MIGRATION = `
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
CREATE INDEX IF NOT EXISTS target_config_revisions_scope_revision_idx
  ON ${schema}.target_config_revisions (installation_id, project_id, revision DESC);

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

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`private plugin database returned invalid ${field}`);
  return value;
}

export function optionalString(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asString(value, field);
}

function asCaseState(value: unknown): DebugCaseState {
  if (value === "open" || value === "in_progress" || value === "resolved" || value === "closed") return value;
  throw new Error("private plugin database returned invalid debug case state");
}

export function asSessionState(value: unknown): DebugSessionState {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error("private plugin database returned invalid debug session state");
}

export function asReportState(value: unknown): DebugReportState {
  if (value === "draft" || value === "final") return value;
  throw new Error("private plugin database returned invalid debug report state");
}

export function asRecord(row: QueryResultRow): TargetConfigRecord {
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

export function asArtifactRecord(row: QueryResultRow): DebugArtifactRecord {
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

export function asCaseRecord(row: QueryResultRow): DebugCaseRecord {
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

export function asSessionRecord(row: QueryResultRow): DebugSessionRecord {
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

export function asObservationRecord(row: QueryResultRow): DebugObservationRecord {
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

export function asReportRecord(row: QueryResultRow): DebugReportRecord {
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

export function asReportRevisionRecord(row: QueryResultRow): DebugReportRevisionRecord {
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

export function boundedText(value: string, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${field} must be non-empty and at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

export function jsonValue(value: unknown, field: string, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch (error) {
    throw new RangeError(`${field} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  return serialized;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
