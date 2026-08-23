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
  title?: string;
  description?: string;
  default?: string | number | boolean;
}

export type ActionInputSchema = Record<string, ActionInputField>;

export interface ActionDescriptor {
  id: string;
  inputSchema: ActionInputSchema;
  wire: { command: string; schemaVersion: number };
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

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: PluginApiVersion;
  displayName?: string;
  profiles: DeviceProfileDescriptor[];
  actions: ActionDescriptor[];
  events: EventDescriptor[];
  ui?: { routes: PluginUiRoute[] };
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
}

export type EventHandler = (context: PluginContext, event: PluginEventInput) => Promise<PluginEventOutput>;
export type ActionEncoder = (input: unknown) => CommandArgument[];
export interface UiRenderInput {
  requestId: string;
  installationId: string;
  projectId: string;
  user: { id: string; locale: string; permissions: string[] };
  routeId: string;
  params: Record<string, string | number | boolean>;
}
export interface UiRenderOutput {
  html: string;
  title?: string;
  status?: number;
  cache?: "no-store" | { maxAgeSeconds: number };
}
export type UiRenderer = (input: UiRenderInput) => Promise<UiRenderOutput>;
export type UiActionHandler = (input: unknown, context: UiRenderInput) => Promise<unknown>;

export interface PluginDefinition {
  manifest: PluginManifest;
  onEvent?: EventHandler;
  encodeAction?: Record<string, ActionEncoder>;
  render?: Record<string, UiRenderer>;
  handleAction?: Record<string, UiActionHandler>;
}

export type InputSchema = z.ZodTypeAny;
