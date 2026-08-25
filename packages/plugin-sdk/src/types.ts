import type { z } from "zod";

export type PluginApiVersion = 1;
export type EntityValueType = "number" | "boolean" | "string" | "enum" | "binary";
export type EntityCategory = "primary" | "diagnostic" | "configuration" | "measurement" | "counter";
export type EntityQuality = "good" | "bad" | "uncertain" | "stale" | "unknown";
export type EntityHistoryPolicy = "none" | "changes" | "sampled" | "all";

export interface EntityDescriptor {
  key: string;
  valueType: EntityValueType;
  category: EntityCategory;
  unit?: string;
  enumValues?: string[];
  staleAfterSeconds?: number;
  history?: EntityHistoryPolicy;
}

export interface DeviceProfileDescriptor {
  id: string;
  version: number;
  manufacturer: string;
  model: string;
  capabilities: string[];
  entities: EntityDescriptor[];
}

export interface ActionInputField {
  type: "string" | "number" | "integer" | "boolean";
  required?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  title?: string;
  description?: string;
  default?: string | number | boolean;
}

export type ActionInputSchema = Record<string, ActionInputField>;

export interface ActionDescriptor {
  id: string;
  inputSchema: ActionInputSchema;
  wire: { command: string; schemaVersion: number };
  /** Destructive device operations must be initiated by an explicit human API request. */
  requiresHumanApproval?: boolean;
}

export interface EventDescriptor {
  kind: string;
  schemaVersion: number;
  description?: string;
}

export interface PluginUiRoute {
  id: string;
  path: string;
  methods?: ("GET" | "POST")[];
  querySchema?: ActionInputSchema;
  actionSchema?: ActionInputSchema;
}

export interface PluginUiAsset {
  path: string;
  contentType: string;
  /** SHA-256 of the exact bytes returned by the asset renderer. */
  sha256: string;
}

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: PluginApiVersion;
  displayName?: string;
  profiles: DeviceProfileDescriptor[];
  actions: ActionDescriptor[];
  events: EventDescriptor[];
  ui?: { routes: PluginUiRoute[]; assets?: PluginUiAsset[] };
}

export type CommandArgValue = string | number | bigint | boolean | null | Uint8Array;
export type CommandArgument = Record<string, CommandArgValue>;

export interface EntityUpdate {
  entityKey: string;
  value?: string | number | boolean | Uint8Array | ArrayBuffer;
  quality?: EntityQuality;
  sourceTimestamp?: string;
  sequence?: bigint | number;
  alarm?: { level: "info" | "warning" | "critical"; code: string } | null;
}

export interface PluginEventInput {
  id: string;
  seq: bigint;
  kind: string;
  schema: number;
  receivedAt: string;
  payload: unknown;
  installation: {
    id: string;
    projectId: string;
    pluginId: string;
    pluginVersion: string;
    config: unknown;
  };
  device: { id: string; uid: string; profileId: string; profileVersion: number };
}

export interface PluginEventOutput {
  updates?: EntityUpdate[];
  logs?: { level: "debug" | "info" | "warn" | "error"; message: string }[];
}

export interface PluginEntityState {
  entityKey: string;
  value: string | number | boolean | null | Uint8Array;
  quality: EntityQuality;
  sourceTimestamp: string | null;
  ingestedAt: string;
  alarm: { level: "info" | "warning" | "critical"; code: string } | null;
}

export interface PluginContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly installation: PluginEventInput["installation"];
  readonly device: PluginEventInput["device"];
  getEntity(entityKey: string): Promise<PluginEntityState | null>;
  enqueueCommand(command: string, args?: CommandArgument[]): Promise<void>;
  callPlugin(pluginId: string, procedure: string, input?: unknown): Promise<unknown>;
}

export type EventHandler = (context: PluginContext, event: PluginEventInput) => Promise<PluginEventOutput>;
export interface ActionEncodingContext {
  operationId: string;
  installationId: string;
  projectId: string;
  deviceId: string;
  userId: string;
  /** Runtime cancellation/deadline signal; optional for source compatibility with pure encoders. */
  signal?: AbortSignal;
  callPlugin?(pluginId: string, procedure: string, input?: unknown): Promise<unknown>;
}
export type ActionEncoder = (input: unknown, context: ActionEncodingContext) => CommandArgument[] | Promise<CommandArgument[]>;
export interface UiRenderInput {
  requestId: string;
  installationId: string;
  projectId: string;
  user: { id: string; locale: string; permissions: string[] };
  routeId: string;
  params: Record<string, string | number | boolean>;
  /** Runtime cancellation/deadline signal; optional for pure renderers. */
  signal?: AbortSignal;
  callPlugin?(pluginId: string, procedure: string, input?: unknown): Promise<unknown>;
}
export interface UiRenderOutput {
  html: string;
  title?: string;
  status?: number;
  cache?: "no-store" | { maxAgeSeconds: number };
}
export type UiRenderer = (input: UiRenderInput) => Promise<UiRenderOutput>;
export type UiActionHandler = (input: unknown, context: UiRenderInput) => Promise<unknown>;
export interface UiAssetInput {
  requestId: string;
  installationId: string;
  projectId: string;
  user: UiRenderInput["user"];
  routeId: string;
  assetPath: string;
  /** Runtime cancellation/deadline signal; optional for pure asset renderers. */
  signal?: AbortSignal;
  callPlugin?(pluginId: string, procedure: string, input?: unknown): Promise<unknown>;
}
export interface UiAssetOutput {
  body: Uint8Array;
  contentType: string;
  cache?: "no-store" | { maxAgeSeconds: number };
}
export type UiAssetRenderer = (input: UiAssetInput) => Promise<UiAssetOutput>;
export interface TargetConfigInput {
  operationId: string;
  installationId: string;
  projectId: string;
  userId: string;
  yaml: string;
}
export interface TargetConfigOutput {
  configId: string;
  revision: number;
  sha256: string;
  targetCount: number;
}
export type TargetConfigHandler = (input: TargetConfigInput, context: { signal: AbortSignal }) => Promise<TargetConfigOutput>;
export interface TargetConfigSummary {
  configId: string;
  revision: number;
  sha256: string;
  targetCount: number;
  createdAt: string;
}
export interface TargetConfigListInput {
  operationId: string;
  installationId: string;
  projectId: string;
  userId: string;
}
export type TargetConfigListHandler = (input: TargetConfigListInput, context: { signal: AbortSignal }) => Promise<TargetConfigSummary[]>;
export interface ArtifactChunkInput {
  operationId: string;
  installationId: string;
  projectId: string;
  userId: string;
  uploadId: string;
  kind: "elf" | "firmware";
  filename: string;
  contentType: string;
  totalSize: number;
  offset: number;
  final: boolean;
  chunk: Uint8Array;
}
export interface ArtifactChunkOutput {
  uploadId: string;
  receivedBytes: number;
  complete: boolean;
  artifactId: string | null;
  sha256: string | null;
}
export type ArtifactChunkHandler = (input: ArtifactChunkInput, context: { signal: AbortSignal }) => Promise<ArtifactChunkOutput>;
export interface ArtifactSummary {
  artifactId: string;
  kind: "elf" | "firmware";
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface ArtifactListInput {
  operationId: string;
  installationId: string;
  projectId: string;
  userId: string;
}
export type ArtifactListHandler = (input: ArtifactListInput, context: { signal: AbortSignal }) => Promise<ArtifactSummary[]>;

export interface PluginCallContext {
  operationId: string;
  signal: AbortSignal;
  caller: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    installationId: string;
    deviceId?: string;
    userId?: string;
  };
  callPlugin(pluginId: string, procedure: string, input?: unknown): Promise<unknown>;
}
export type PluginCallHandler = (input: unknown, context: PluginCallContext) => Promise<unknown>;

export interface PluginDefinition {
  manifest: PluginManifest;
  onEvent?: EventHandler;
  encodeAction?: Record<string, ActionEncoder>;
  render?: Record<string, UiRenderer>;
  handleAction?: Record<string, UiActionHandler>;
  assets?: Record<string, UiAssetRenderer>;
  /** Optional product-specific configuration hook used by the SoulInjector plugin. */
  configureTarget?: TargetConfigHandler;
  listTargetConfigs?: TargetConfigListHandler;
  storeArtifactChunk?: ArtifactChunkHandler;
  listArtifacts?: ArtifactListHandler;
  /** Explicitly named procedures callable through Plugin Manager scope checks. */
  handleCall?: Record<string, PluginCallHandler>;
}

export type InputSchema = z.ZodTypeAny;
