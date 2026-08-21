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
 * Arguments accepted by the existing command wire contract: scalar values
 * or raw binary. Complex structures are MessagePack-encoded by the plugin
 * into a single binary argument.
 */
export type CommandArgument =
  | { str: string }
  | { u64: bigint | number }
  | { i64: bigint | number }
  | { f64: number }
  | { bin: Uint8Array };

export interface ActionDescriptor {
  id: string;
  /** Schema description of the action input (validated before dispatch). */
  inputSchema: Record<string, unknown>;
  wire: {
    command: string;
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
  /**
   * Stage 4+ (station workflows) and stage 3 (declarative UI) placeholders:
   * declared now so the manifest shape is stable across stages.
   */
  workflows: [];
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

export interface ScopedJobService {
  /**
   * Create a station/plugin job (stage 4+). Declared for forward
   * compatibility only.
   */
  createJob(request: Record<string, unknown>): Promise<{ jobId: string }>;
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
  jobs: ScopedJobService;
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
