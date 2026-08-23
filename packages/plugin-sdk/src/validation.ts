import { z } from "zod";
import type { ActionInputSchema, EntityDescriptor, EntityUpdate, PluginManifest } from "./types";

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.bigint(), z.null(), z.instanceof(Uint8Array)]);
const field = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  required: z.boolean().optional(),
  enum: z.array(z.string().max(1024)).min(1).max(128).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  title: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();

export const actionInputFieldSchema = field;
export const actionInputSchema = z.record(z.string().min(1).max(128), field).refine((value) => Object.keys(value).length <= 64, "too many input fields");

export const entityDescriptorSchema = z.object({
  key: z.string().min(1).max(128),
  valueType: z.enum(["number", "boolean", "string", "enum", "binary"]),
  category: z.enum(["primary", "diagnostic", "configuration", "measurement", "counter"]),
  unit: z.string().max(64).optional(),
  enumValues: z.array(z.string().min(1).max(128)).max(128).optional(),
  staleAfterSeconds: z.number().int().positive().max(31_536_000).optional(),
  history: z.enum(["none", "changes", "sampled", "all"]).optional(),
}).strict();

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(128),
  version: z.string().min(1).max(128),
  apiVersion: z.literal(1),
  displayName: z.string().max(256).optional(),
  profiles: z.array(z.object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    manufacturer: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    capabilities: z.array(z.string().min(1).max(128)).max(128),
    entities: z.array(entityDescriptorSchema).max(512),
  }).strict()).max(128),
  actions: z.array(z.object({
    id: z.string().min(1).max(128),
    inputSchema: actionInputSchema,
    wire: z.object({ command: z.string().min(1).max(256), schemaVersion: z.number().int().positive() }).strict(),
  }).strict()).max(256),
  events: z.array(z.object({ kind: z.string().min(1).max(256), schemaVersion: z.number().int().positive(), description: z.string().max(2048).optional() }).strict()).max(256),
  ui: z.object({ routes: z.array(z.object({
    id: z.string().min(1).max(128),
    path: z.string().regex(/^\/(?:[A-Za-z0-9._~-]+\/?)*$/).max(256)
      .refine((path) => path.split("/").every((segment) => segment !== "." && segment !== ".."), "path traversal is not allowed"),
    methods: z.array(z.enum(["GET", "POST"])).min(1).max(2).optional(),
    querySchema: actionInputSchema.optional(),
    actionSchema: actionInputSchema.optional(),
  }).strict().refine((route) => !(route.methods ?? ["GET"]).includes("POST") || route.actionSchema !== undefined, {
    message: "POST routes require actionSchema",
  })).max(128) }).strict().optional(),
}).strict();

export function validateManifest(value: unknown): PluginManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const manifest = result.data;
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
  };
  unique(manifest.profiles.map((item) => `${item.id}@${item.version}`), "profile");
  unique(manifest.actions.map((item) => item.id), "action");
  unique(manifest.events.map((item) => `${item.kind}@${item.schemaVersion}`), "event");
  unique(manifest.ui?.routes.map((item) => item.id) ?? [], "UI route ID");
  unique(manifest.ui?.routes.map((item) => item.path) ?? [], "UI route path");
  for (const route of manifest.ui?.routes ?? []) unique(route.methods ?? ["GET"], `method in UI route ${route.id}`);
  for (const profile of manifest.profiles) {
    unique(profile.capabilities, `capability in ${profile.id}`);
    unique(profile.entities.map((item) => item.key), `entity in ${profile.id}`);
    for (const entity of profile.entities) {
      if (entity.valueType === "enum") {
        if (!entity.enumValues || entity.enumValues.length === 0) {
          throw new Error(`enum entity ${profile.id}.${entity.key} requires enumValues`);
        }
        unique(entity.enumValues, `enum value in ${profile.id}.${entity.key}`);
      } else if (entity.enumValues !== undefined) {
        throw new Error(`non-enum entity ${profile.id}.${entity.key} cannot declare enumValues`);
      }
    }
  }
  for (const action of manifest.actions) validateActionSchemaDeclaration(action.id, action.inputSchema);
  for (const route of manifest.ui?.routes ?? []) {
    if (route.querySchema) validateActionSchemaDeclaration(`UI route ${route.id} query`, route.querySchema);
    if (route.actionSchema) validateActionSchemaDeclaration(`UI route ${route.id} action`, route.actionSchema);
  }
  return manifest;
}

function validateActionSchemaDeclaration(label: string, schema: ActionInputSchema): void {
  for (const [key, rule] of Object.entries(schema)) {
    const numeric = rule.type === "number" || rule.type === "integer";
    if (!numeric && (rule.min !== undefined || rule.max !== undefined)) {
      throw new Error(`${label}.${key} can only declare min/max for numeric types`);
    }
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
      throw new Error(`${label}.${key} min cannot exceed max`);
    }
    if (rule.enum !== undefined && rule.type !== "string") {
      throw new Error(`${label}.${key} can only declare enum for string fields`);
    }
    if (rule.enum && new Set(rule.enum).size !== rule.enum.length) {
      throw new Error(`${label}.${key} contains duplicate enum values`);
    }
    if (rule.default !== undefined) {
      const result = validateActionInput({ [key]: { ...rule, required: true } }, { [key]: rule.default });
      if (!result.ok) throw new Error(`${label}.${key} has an invalid default: ${result.failures[0]?.error ?? "invalid value"}`);
    }
  }
}

export interface ValidationFailure { field: string; error: string }

/** Coerces URL/form scalar strings according to a manifest schema. */
export function coerceStringActionInput(schema: ActionInputSchema, input: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = schema[key];
    if (!rule || rule.type === "string") {
      result[key] = value;
    } else if (rule.type === "boolean") {
      result[key] = value === "true" ? true : value === "false" ? false : value;
    } else {
      result[key] = value.trim() === "" ? value : Number(value);
    }
  }
  return result;
}

export function validateActionInput(schema: ActionInputSchema, input: unknown): { ok: true } | { ok: false; failures: ValidationFailure[] } {
  const failures: ValidationFailure[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, failures: [{ field: "(root)", error: "input must be an object" }] };
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!schema[key]) failures.push({ field: key, error: "unknown field" });
  for (const [key, rule] of Object.entries(schema)) {
    const value = record[key];
    if (value === undefined) { if (rule.required) failures.push({ field: key, error: "is required" }); continue; }
    const typeOk = rule.type === "string" ? typeof value === "string" : rule.type === "boolean" ? typeof value === "boolean" : typeof value === "number" && Number.isFinite(value) && (rule.type !== "integer" || Number.isInteger(value));
    if (!typeOk) { failures.push({ field: key, error: `expected ${rule.type}` }); continue; }
    if (rule.enum && !rule.enum.includes(value as string)) failures.push({ field: key, error: "is not an allowed value" });
    if (typeof value === "number" && rule.min !== undefined && value < rule.min) failures.push({ field: key, error: `must be >= ${rule.min}` });
    if (typeof value === "number" && rule.max !== undefined && value > rule.max) failures.push({ field: key, error: `must be <= ${rule.max}` });
  }
  return failures.length ? { ok: false, failures } : { ok: true };
}

function valueMatches(descriptor: EntityDescriptor, value: unknown): boolean {
  if (value === undefined) return true;
  if (descriptor.valueType === "number") return typeof value === "number" && Number.isFinite(value);
  if (descriptor.valueType === "boolean") return typeof value === "boolean";
  if (descriptor.valueType === "string") return typeof value === "string";
  if (descriptor.valueType === "binary") return value instanceof Uint8Array || value instanceof ArrayBuffer;
  return typeof value === "string" && !!descriptor.enumValues?.includes(value);
}

export function validateEntityUpdates(descriptors: EntityDescriptor[], updates: EntityUpdate[]): void {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  if (!Array.isArray(updates) || updates.length > 4096) throw new Error("invalid entity update list");
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.entityKey)) throw new Error(`duplicate entity update ${update.entityKey}`);
    seen.add(update.entityKey);
    const descriptor = byKey.get(update.entityKey);
    if (!descriptor) throw new Error(`unknown entity ${update.entityKey}`);
    if (!valueMatches(descriptor, update.value)) throw new Error(`invalid value for entity ${update.entityKey}`);
    if (update.quality && !["good", "bad", "uncertain", "stale", "unknown"].includes(update.quality)) throw new Error(`invalid quality for entity ${update.entityKey}`);
    if (update.sequence !== undefined) {
      const validSequence = typeof update.sequence === "bigint"
        ? update.sequence >= 0n
        : Number.isSafeInteger(update.sequence) && update.sequence >= 0;
      if (!validSequence) throw new Error(`invalid sequence for entity ${update.entityKey}`);
    }
    if (update.sourceTimestamp !== undefined && Number.isNaN(new Date(update.sourceTimestamp).getTime())) {
      throw new Error(`invalid source timestamp for entity ${update.entityKey}`);
    }
    if (update.alarm && (update.alarm.code.length < 1 || update.alarm.code.length > 256)) {
      throw new Error(`invalid alarm code for entity ${update.entityKey}`);
    }
  }
}
