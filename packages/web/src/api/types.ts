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
