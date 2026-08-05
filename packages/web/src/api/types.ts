/** Shared API response shapes (snake_case, matching the Elysia contract). */

export interface ProjectSummary {
  project_id: string;
  name: string;
  device_count: number;
}

export interface MeResponse {
  user_id: string;
  username: string;
  projects: ProjectSummary[];
}

export interface AuthResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/** Standard error body: { error: string, message: string }. */
export interface ApiError {
  error: string;
  message: string;
}

// --- devices ----------------------------------------------------------------

export interface DeviceFirmware {
  fw_hash: string;
  reported_at: string;
}

export interface DeviceSummary {
  device_id: string;
  device_uid: string;
  assigned_id: string;
  auth_revoked: boolean;
  firmware: DeviceFirmware | null;
}

export interface DeviceListResponse {
  total: number;
  devices: DeviceSummary[];
}

export interface DeviceDetail {
  device_id: string;
  device_uid: string;
  assigned_id: string;
  project_id: string;
  auth_revoked: boolean;
  next_command_sequence: string;
  firmware: DeviceFirmware | null;
}

export interface CreateDeviceRequest {
  project_id: string;
  assigned_id: string;
  device_uid: string;
}

export interface CreateDeviceResponse {
  device_id: string;
  device_uid: string;
  assigned_id: string;
  mqtt_username: string;
  mqtt_password: string;
  note: string;
}

export interface IssuedCredentials {
  device_id: string;
  mqtt_username: string;
  mqtt_password: string;
  note: string;
}

export interface RevokeCredentialsResponse {
  device_id: string;
  revoked: boolean;
  session_killed: boolean;
}

// --- commands ----------------------------------------------------------------

export type CommandState =
  | "queued"
  | "leased"
  | "broker_accepted"
  | "device_completed"
  | "delivery_failed";

export interface CommandPayload {
  cmd: string;
  args: unknown;
}

export interface CommandResult {
  code: number;
  payload: unknown;
}

export interface CommandRecord {
  command_id: string;
  batch_id: string;
  sequence: string;
  command: CommandPayload | null;
  state: CommandState;
  result_code: number | null;
  result: CommandResult | null;
  created_at: string;
  delivery_expires_at: string | null;
  device_completed_at: string | null;
}

export interface CommandListResponse {
  commands: CommandRecord[];
  next_cursor: string | null;
}

export interface BatchCommandRecord extends CommandRecord {
  device_id: string;
  device_uid: string;
}

export interface CommandBatchDetail {
  batch_id: string;
  device_count: number;
  created_at: string;
  summary: Partial<Record<CommandState, number>>;
  commands: BatchCommandRecord[];
}

export interface CommandBatchRequest {
  device_ids: string[];
  command: CommandPayload;
  delivery_timeout_seconds?: number;
}

export interface CommandBatchResponse {
  batch_id: string;
  device_count: number;
}

// --- logs --------------------------------------------------------------------

export interface LogEvent {
  id: string;
  received_at: string;
  device_time_ms: string;
  sequence: number;
  packet_type: number;
  level: number | null;
  tag: string | null;
  message: string | null;
  decode_state: "unknown_fw" | "decodable";
  raw_packet_b64?: string;
}

export interface LogListResponse {
  events: LogEvent[];
  next_cursor: string | null;
}

// --- firmware -----------------------------------------------------------------

export interface FirmwareState {
  device_id: string;
  device_uid: string;
  fw_hash: string;
  artifact_id: string | null;
  artifact_version: string | null;
  reported_at: string;
}

export interface BindFirmwareResponse {
  device_id: string;
  artifact_id: string;
  backfilled_events: number;
}

export interface ArtifactSummary {
  artifact_id: string;
  build_id: string;
  version: string | null;
  elf_size: number;
  import_state: string;
  uploaded_at: string;
  dictionary_entries: number;
}

export interface ArtifactListResponse {
  artifacts: ArtifactSummary[];
}

export interface ArtifactUploadResponse {
  artifact_id: string;
  build_id: string;
  import_state: string;
  tag_count: number;
  format_count: number;
  backfilled_events: number;
}

// --- firmware releases ---------------------------------------------------------

export interface ReleaseSummary {
  release_id: string;
  bin_hash: string;
  bin_size: number;
  version: string | null;
  artifact_id: string | null;
  created_at: string;
}

export interface ReleaseListResponse {
  items: ReleaseSummary[];
  next_cursor: string | null;
}

export interface ReleaseDetail {
  release_id: string;
  bin_hash: string;
  bin_size: number;
  version: string | null;
  created_at: string;
  artifact: {
    artifact_id: string;
    build_id: string;
    dictionary_entries: number;
  } | null;
}

export interface ReleaseUploadResponse {
  release_id: string;
  bin_hash: string;
  bin_size: number;
  artifact_id: string | null;
  version: string | null;
}

// --- OTA jobs ------------------------------------------------------------------

export type OtaTargetState =
  | "pending"
  | "leased"
  | "delivered"
  | "delivering"
  | "downloaded"
  | "installed"
  | "expired"
  | "completed"
  | "failed";

export interface OtaJobTarget {
  device_id: string;
  device_uid: string;
  state: OtaTargetState;
  delivered_at: string | null;
  confirmed_at: string | null;
  result_code: number | null;
  result_message: string | null;
  current_fw: string | null;
}

export interface OtaJobDetail {
  job_id: string;
  release_id: string;
  created_at: string;
  targets: OtaJobTarget[];
  summary: Partial<Record<OtaTargetState, number>>;
}

export interface OtaJobSummary {
  job_id: string;
  release_id: string;
  created_at: string;
  target_count: number;
  summary: Partial<Record<OtaTargetState, number>>;
}

export interface OtaJobListResponse {
  total: number;
  jobs: OtaJobSummary[];
}

export interface DeployResponse {
  job_id: string;
  targets: Array<{ device_id: string; device_uid: string; state: string }>;
}

// --- rollouts ------------------------------------------------------------------

export type RolloutState = "running" | "paused" | "aborted" | "completed";
export type RolloutStrategy = "auto" | "grouped";
export type RolloutPhaseState = "pending" | "active" | "completed" | "paused";

export interface RolloutSummary {
  rollout_id: string;
  release_id: string;
  from_release_id: string | null;
  state: RolloutState;
  strategy: RolloutStrategy;
  manual_approval: boolean;
  created_at: string;
  pool_size: number;
  progress: Partial<Record<OtaTargetState, number>>;
}

export interface RolloutListResponse {
  total: number;
  rollouts: RolloutSummary[];
}

export interface RolloutPhase {
  index: number;
  ratio: number | null;
  group_id: number | null;
  state: RolloutPhaseState;
  target_count: number;
  job_id: string | null;
  activated_at: string | null;
  completed_at: string | null;
  summary: Partial<Record<OtaTargetState, number>> | null;
}

export interface RolloutDetail {
  rollout_id: string;
  release_id: string;
  from_release_id: string | null;
  state: RolloutState;
  strategy: RolloutStrategy;
  success_ratio: number;
  min_sample: number;
  phase_timeout_hours: number;
  stuck_hours: number;
  manual_approval: boolean;
  rollback_job_id: string | null;
  created_at: string;
  pool_size: number;
  phases: RolloutPhase[];
}

export interface RolloutCreateRequest {
  strategy: RolloutStrategy;
  device_ids?: string[];
  ratios?: number[];
  phases?: Array<{ device_ids: string[] }>;
  from_release_id?: string;
  success_ratio?: number;
  min_sample?: number;
  phase_timeout_hours?: number;
  stuck_hours?: number;
  manual_approval?: boolean;
}

export interface RolloutCreateResponse {
  rollout_id: string;
  phases: Array<{ index: number; target_count: number; state: string }>;
  job_id: string | null;
}
