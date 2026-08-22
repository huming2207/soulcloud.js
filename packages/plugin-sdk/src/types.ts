/**
 * Plugin-facing types (stage 1 skeleton).
 *
 * Design rules from docs/zh/plugin-and-station-architecture.md:
 *   §2  compile-time registration: plugins ship with the deployment; there
 *       is no runtime install, no directory scan, no remote module load.
 *   §4  industrial entity model: devices expose stable logical endpoints
 *       with quality/alarm semantics — NOT the Home Assistant light/switch/
 *       climate domains.
 *   §6.4 plugins only see scoped services bound to their installation and
 *       project; they never receive a Prisma client, database credentials,
 *       user JWTs or global secrets.
 */

// ---------------------------------------------------------------------------
// Entity descriptors (§4)
// ---------------------------------------------------------------------------

export type EntityValueType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "binary";

export type EntityAccess = "read" | "write" | "read_write";

export type EntityCategory =
  | "primary"
  | "diagnostic"
  | "configuration"
  | "measurement"
  | "counter";

/** How samples land in `entity_history` (§4 retention policy). */
export type EntityHistoryPolicy = "none" | "changes" | "sampled" | "all";

export interface EntityDescriptor {
  /** Stable semantic identity; renaming = new entity (§4.1). */
  key: string;
  valueType: EntityValueType;
  access: EntityAccess;
  category: EntityCategory;
  unit?: string;
  /** Required when valueType === "enum". */
  enumValues?: string[];
  /** Mark the current state stale after this many seconds. */
  staleAfterSeconds?: number;
  history: EntityHistoryPolicy;
  /** Minimum spacing between history samples (history === "sampled"). */
  sampleIntervalSeconds?: number;
  displayName?: string;
}

export type EntityQuality = "good" | "bad" | "uncertain" | "stale" | "unknown";

export interface EntityAlarm {
  level: "info" | "warning" | "critical";
  code: string;
}

/** A plugin-produced entity mutation, part of an event-handling result. */
export interface EntityUpdate {
  entityKey: string;
  value?: unknown;
  quality?: EntityQuality;
  /** ISO-8601 producer timestamp (clock quality tracked at ingest, §9.5). */
  sourceTimestamp?: string;
  /** Optional producer-side monotonic ordering token. */
  sequence?: bigint | number;
  /** null clears a previously raised alarm. */
  alarm?: EntityAlarm | null;
}

// ---------------------------------------------------------------------------
// Device profiles (§3)
// ---------------------------------------------------------------------------

export interface DeviceProfileDescriptor {
  id: string;
  /** Bumped on incompatible changes; running devices pin their version. */
  version: number;
  manufacturer: string;
  model: string;
  capabilities: string[];
  entities: EntityDescriptor[];
}

// ---------------------------------------------------------------------------
// Actions (§5) — encoded onto the existing DeviceCommand wire contract
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by the existing command wire contract: an array of
 * single-key maps whose values are scalars or raw binary (§5). The key is
 * the argument NAME the device firmware reads; complex structures are
 * MessagePack-encoded by the plugin into one binary argument.
 */
export type CommandArgValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array;

export type CommandArgument = {
  /** Exactly one key per argument. */
  [name: string]: CommandArgValue;
};

/**
 * Flat input-schema field: one declarative form field / validation rule.
 * The same declaration drives API-side validation and the web console's
 * rendered form (§7.1) — see `validateActionInput`.
 */
export interface ActionInputField {
  type: "string" | "number" | "integer" | "boolean";
  /** Absent/undefined input fails when required (default: optional). */
  required?: boolean;
  /** Restricts a string field to these values. */
  enum?: string[];
  /** Inclusive bounds for number/integer fields. */
  min?: number;
  max?: number;
  /** Form label; falls back to the field name. */
  title?: string;
  /** Helper text below the form field. */
  description?: string;
  /** Pre-filled form value (never applied server-side). */
  default?: string | number | boolean;
}

export type ActionInputSchema = Record<string, ActionInputField>;

export interface ActionDescriptor {
  id: string;
  /**
   * Flat input schema rendered as the action form and validated before
   * dispatch (see `validateActionInput`).
   */
  inputSchema: ActionInputSchema;
  wire: {
    command: string;
    /** Declared wire schema version; metadata for dry-run/UI display. */
    schemaVersion: number;
    /** Encode validated input into DeviceCommand args. */
    encode: (input: unknown) => CommandArgument[];
  };
}

// ---------------------------------------------------------------------------
// Events (§5) — the generic device uplink envelope `/event`
// ---------------------------------------------------------------------------

export interface EventDescriptor {
  kind: string;
  schemaVersion: number;
  description?: string;
}

// ---------------------------------------------------------------------------
// Station workflows (§8–§10, stage 4)
// ---------------------------------------------------------------------------

/** JSON values accepted by a workflow input or a station result. */
export type StationJsonValue =
  | string
  | number
  | boolean
  | null
  | StationJsonValue[]
  | { readonly [key: string]: StationJsonValue };

export type StationWorkflowInput = Readonly<{
  [key: string]: StationJsonValue;
}>;

export interface StationResourceRequirement {
  /** Stable local resource class, e.g. `serial` or `jtag`. */
  type: string;
  /** Agent-local stable identifier. */
  id: string;
  exclusive: boolean;
}

export type StationRecoveryPolicy =
  | "retry"
  | "quarantine"
  | "scrap"
  | "manual";

/** Immutable step descriptor copied into every station-job snapshot. */
export interface StationWorkflowStepDescriptor {
  id: string;
  /** Runner executor identifier, not an arbitrary command line. */
  executor: string;
  timeoutSeconds: number;
  maxAttempts: number;
  resources?: readonly StationResourceRequirement[];
  /** True once cancellation may leave a DUT or identity half-written. */
  irreversible: boolean;
  recoveryPolicy: StationRecoveryPolicy;
}

/** Versioned, compile-time registered station workflow. */
export interface StationWorkflowDescriptor {
  id: string;
  version: number;
  displayName?: string;
  /** Capabilities an agent must advertise before it can claim this workflow. */
  requiredCapabilities: readonly string[];
  /** Reuses the flat declarative field language used by Actions. */
  inputSchema: ActionInputSchema;
  steps: readonly StationWorkflowStepDescriptor[];
  maxDurationSeconds: number;
}

export interface StationArtifactReference {
  artifactId: string;
  sha256: string;
  size: number;
  kind: string;
}

/** Request created by a scoped plugin operation or the station control plane. */
export interface StationJobRequest {
  workflowId: string;
  workflowVersion: number;
  input: StationWorkflowInput;
  idempotencyKey: string;
  artifacts?: readonly StationArtifactReference[];
}

export interface StationCapabilities {
  protocolVersion: 1;
  agentClass: "full" | "embedded";
  platform: "linux" | "windows" | "mcu";
  transports: readonly ("https" | "mqtt-wss")[];
  executors: readonly string[];
  maxArtifactBytes: number;
  maxEventBytes: number;
  maxConcurrentJobs: number;
  supportsHttpRange: boolean;
  supportsProcessIsolation: boolean;
}

export interface StationJobLease {
  stationId: string;
  attemptId: string;
  /** Monotonically increasing fencing token; stale updates are rejected. */
  generation: number;
  expiresAt: string;
}

/** Proof attached to every progress/completion write from an Agent. */
export interface StationJobLeaseProof {
  attemptId: string;
  /** Must match the currently leased attempt; prevents stale-agent writes. */
  generation: number;
}

/** Server-issued immutable job snapshot consumed by an Agent. */
export interface StationJobSnapshot {
  jobId: string;
  projectId: string;
  plugin: {
    id: string;
    version: string;
    apiVersion: PluginApiVersion;
  };
  workflow: StationWorkflowDescriptor;
  input: StationWorkflowInput;
  artifacts: readonly StationArtifactReference[];
  target?: {
    deviceId: string;
    deviceUid: string;
    profileId: string;
    profileVersion: number;
  };
  lease: StationJobLease;
}

export type StationStepState =
  | "started"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface StationStepUpdate {
  jobId: string;
  lease: StationJobLeaseProof;
  sequence: number;
  stepId: string;
  state: StationStepState;
  occurredAt: string;
  durationMs?: number;
  output?: StationJsonValue;
  error?: { code: string; message: string };
}

export interface StationJobCompletion {
  jobId: string;
  lease: StationJobLeaseProof;
  finalSequence: number;
  status: "succeeded" | "failed" | "cancelled" | "cancel_forced";
  result?: StationJsonValue;
  artifacts?: readonly StationArtifactReference[];
}

// ---------------------------------------------------------------------------
// Plugin manifest (§2)
// ---------------------------------------------------------------------------

/** Plugin SDK API version this plugin was compiled against. */
export type PluginApiVersion = 1;

export interface PluginManifest {
  /** Stable reverse-domain id, e.g. "soulcloud.generic". */
  id: string;
  /** Must exactly match the version the dispatcher has deployed (§3). */
  version: string;
  apiVersion: PluginApiVersion;
  displayName?: string;
  profiles: DeviceProfileDescriptor[];
  actions: ActionDescriptor[];
  events: EventDescriptor[];
  /** Versioned station workflows shipped with this plugin. */
  workflows: StationWorkflowDescriptor[];
  ui: Record<string, never>;
}

// ---------------------------------------------------------------------------
// Plugin runtime contract (§6.4)
// ---------------------------------------------------------------------------

/** The device-bound event handed to the worker. */
export interface PluginEventInput {
  eventId: string;
  eventKind: string;
  schemaVersion: number;
  /** Decoded envelope `data` — interpreted exclusively by the plugin. */
  payload: unknown;
  device: {
    id: string;
    deviceUid: string;
    profileId: string;
    profileVersion: number;
  };
  /** Server receive time (ISO-8601). */
  receivedAt: string;
}

export interface PluginEventResult {
  /** Entity mutations to apply; validated by the dispatcher before commit. */
  updates?: EntityUpdate[];
}

export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Read access to an entity's current state. Writes flow through the event
 * result (`updates`), never through this service.
 */
export interface ScopedEntityService {
  get(entityKey: string): Promise<EntityStateSnapshot | null>;
}

export interface EntityStateSnapshot {
  entityKey: string;
  value: unknown;
  quality: EntityQuality;
  sourceTimestamp: string | null;
  ingestedAt: string;
  alarm: EntityAlarm | null;
}

export interface ScopedDeviceService {
  /** Hardware UID of the device this installation routed the event from. */
  getDeviceUid(): Promise<string>;
}

export interface ScopedCommandService {
  /**
   * Enqueue a DeviceCommand through the existing durable command queue
   * (stage 3: action dispatch).
   */
  enqueueCommand(command: string, args: CommandArgument[]): Promise<void>;
}

export interface ScopedStationJobService {
  /** Create a station job bound to this operation's project/device scope. */
  create(request: StationJobRequest): Promise<{ jobId: string }>;
}

/**
 * Everything a plugin worker may touch. The SDK binds installation and
 * project; there is deliberately no way to address another project.
 */
export interface PluginContext {
  installation: {
    id: string;
    projectId: string;
    config: unknown;
  };
  devices: ScopedDeviceService;
  commands: ScopedCommandService;
  entities: ScopedEntityService;
  stationJobs: ScopedStationJobService;
  logger: PluginLogger;
  /** Fired when the dispatcher deadline expires; well-behaved plugins abort. */
  signal: AbortSignal;
}

export interface PluginWorker {
  /**
   * Handle one device event. Must be idempotent: the dispatcher provides
   * at-least-once delivery (a response can be lost after the update was
   * applied), so replays of the same eventId may occur.
   */
  onEvent(ctx: PluginContext, event: PluginEventInput): Promise<PluginEventResult>;
}
