/**
 * Shared pure validators for plugin metadata and plugin output.
 *
 * Run on BOTH sides of the trust boundary:
 *   - the Plugin Host pre-validates its own output so oversized/invalid
 *     responses fail fast with a precise error instead of being rejected
 *     by the dispatcher after a round trip;
 *   - the Dispatcher is the authority: it re-validates every update before
 *     anything is committed (§6.3 "校验插件输出").
 *
 * No I/O, no imports beyond local types — safe to load in any process.
 */

import { z } from "zod";
import type {
  EntityDescriptor,
  EntityUpdate,
  PluginManifest,
} from "./types";

// ---------------------------------------------------------------------------
// Bounded sizes (§15: every plugin call limits input, output and update sizes)
// ---------------------------------------------------------------------------

export const MAX_ENTITY_KEY_LENGTH = 255;
export const MAX_ENTITY_STRING_BYTES = 16 * 1024;
export const MAX_ENTITY_BINARY_BYTES = 64 * 1024;
export const MAX_ENTITY_ENUM_VALUES = 256;
export const MAX_PROFILE_ENTITIES = 512;
export const MAX_MANIFEST_PROFILES = 64;
export const MAX_EVENT_KIND_LENGTH = 255;
/** Per-update serialised value cap (JSON string length). */
export const MAX_ENTITY_VALUE_JSON_BYTES = 64 * 1024;
/** Updates a single event may produce. */
export const MAX_UPDATES_PER_EVENT = 100;

const ENTITY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,254}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,254}$/;

// ---------------------------------------------------------------------------
// Descriptor / manifest schemas (zod — compile-time registration means
// validation runs in tests and at host boot, not on any hot path)
// ---------------------------------------------------------------------------

const entityDescriptorSchema = z.object({
  key: z.string().regex(ENTITY_KEY_PATTERN),
  valueType: z.enum(["number", "boolean", "string", "enum", "binary"]),
  access: z.enum(["read", "write", "read_write"]),
  category: z.enum([
    "primary",
    "diagnostic",
    "configuration",
    "measurement",
    "counter",
  ]),
  unit: z.string().max(32).optional(),
  enumValues: z.array(z.string().min(1).max(255)).max(MAX_ENTITY_ENUM_VALUES).optional(),
  staleAfterSeconds: z.number().int().positive().optional(),
  history: z.enum(["none", "changes", "sampled", "all"]),
  sampleIntervalSeconds: z.number().int().positive().optional(),
  displayName: z.string().max(255).optional(),
});

export const deviceProfileDescriptorSchema = z.object({
  id: z.string().regex(ENTITY_KEY_PATTERN),
  version: z.number().int().positive(),
  manufacturer: z.string().min(1).max(255),
  model: z.string().min(1).max(255),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  entities: z.array(entityDescriptorSchema).max(MAX_PROFILE_ENTITIES),
});

export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/).max(64),
  apiVersion: z.literal(1),
  displayName: z.string().max(255).optional(),
  profiles: z.array(deviceProfileDescriptorSchema).max(MAX_MANIFEST_PROFILES),
  actions: z.array(z.object({
    id: z.string().regex(ENTITY_KEY_PATTERN),
    inputSchema: z.record(z.string(), z.unknown()),
    wire: z.object({
      command: z.string().min(1).max(255),
      schemaVersion: z.number().int().positive(),
      encode: z.function(),
    }),
  })).max(128),
  events: z.array(z.object({
    kind: z.string().min(1).max(MAX_EVENT_KIND_LENGTH),
    schemaVersion: z.number().int().positive(),
    description: z.string().max(1024).optional(),
  })).max(128),
  workflows: z.array(z.never()).max(0),
  ui: z.record(z.string(), z.never()),
});

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** Runtime identity: validate a manifest object (registry boot / tests). */
export function validatePluginManifest(
  manifest: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = pluginManifestSchema.safeParse(manifest);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `manifest invalid at ${issue?.path.join(".") ?? "<root>"}: ${issue?.message ?? "unknown"}`,
    };
  }
  // cross-field rules zod cannot express cleanly
  const m = result.data as PluginManifest;
  const profileIds = new Set<string>();
  const actionIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const profile of m.profiles) {
    const profileIdentity = `${profile.id}@${profile.version}`;
    if (profileIds.has(profileIdentity)) {
      return { ok: false, error: `duplicate profile "${profileIdentity}"` };
    }
    profileIds.add(profileIdentity);
    const entityKeys = new Set<string>();
    for (const entity of profile.entities) {
      if (entityKeys.has(entity.key)) {
        return { ok: false, error: `duplicate entity key "${entity.key}" in profile "${profileIdentity}"` };
      }
      entityKeys.add(entity.key);
      if (entity.valueType === "enum" && !entity.enumValues?.length) {
        return {
          ok: false,
          error: `entity "${entity.key}" is enum but declares no enumValues`,
        };
      }
      if (entity.history === "sampled" && entity.sampleIntervalSeconds === undefined) {
        return {
          ok: false,
          error: `entity "${entity.key}" uses sampled history but has no sampleIntervalSeconds`,
        };
      }
    }
  }
  for (const action of m.actions) {
    if (actionIds.has(action.id)) {
      return { ok: false, error: `duplicate action id "${action.id}"` };
    }
    actionIds.add(action.id);
  }
  for (const event of m.events) {
    const identity = `${event.kind}@${event.schemaVersion}`;
    if (eventIds.has(identity)) {
      return { ok: false, error: `duplicate event "${identity}"` };
    }
    eventIds.add(identity);
  }
  return { ok: true, manifest: m };
}

// ---------------------------------------------------------------------------
// Entity value validation (descriptor -> value)
// ---------------------------------------------------------------------------

export type EntityValueCheck =
  | { ok: true }
  | { ok: false; error: string };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Validate a plugin-supplied value against its descriptor. */
export function validateEntityValue(
  descriptor: EntityDescriptor,
  value: unknown,
): EntityValueCheck {
  if (value === undefined || value === null) {
    // A missing value is legal (quality/alarm-only updates, e.g. going
    // "unknown" without a reading).
    return { ok: true };
  }
  switch (descriptor.valueType) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "expected a finite number" };
      }
      return { ok: true };
    case "boolean":
      if (typeof value !== "boolean") {
        return { ok: false, error: "expected a boolean" };
      }
      return { ok: true };
    case "string":
      if (typeof value !== "string") {
        return { ok: false, error: "expected a string" };
      }
      if (byteLength(value) > MAX_ENTITY_STRING_BYTES) {
        return {
          ok: false,
          error: `string exceeds ${MAX_ENTITY_STRING_BYTES} bytes`,
        };
      }
      return { ok: true };
    case "enum":
      if (typeof value !== "string") {
        return { ok: false, error: "expected an enum string" };
      }
      if (!descriptor.enumValues?.includes(value)) {
        return {
          ok: false,
          error: `"${value}" is not one of the declared enum values`,
        };
      }
      return { ok: true };
    case "binary":
      // JSON transport: binary values are base64 strings.
      if (typeof value !== "string") {
        return { ok: false, error: "expected a base64 string" };
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        return { ok: false, error: "expected valid base64" };
      }
      if ((value.length * 3) / 4 > MAX_ENTITY_BINARY_BYTES) {
        return {
          ok: false,
          error: `binary exceeds ${MAX_ENTITY_BINARY_BYTES} bytes`,
        };
      }
      return { ok: true };
  }
}

/** Serialised size guard for values that pass type validation. */
export function entityValueFits(
  value: unknown,
  maxJsonBytes: number = MAX_ENTITY_VALUE_JSON_BYTES,
): boolean {
  try {
    return byteLength(JSON.stringify(value ?? null)) <= maxJsonBytes;
  } catch {
    return false;
  }
}

export interface UpdateCheckFailure {
  index: number;
  entityKey: string;
  error: string;
}

/**
 * Validate a plugin event result's updates against the profile's entity
 * descriptors. Returns the first failures (bounded) — the dispatcher treats
 * ANY failure as invalid plugin output (§6.3), the host uses it for a fast
 * local pre-check.
 */
export function validateEventUpdates(
  entities: readonly EntityDescriptor[],
  updates: readonly EntityUpdate[] | unknown,
): { ok: true } | { ok: false; failures: UpdateCheckFailure[] } {
  if (!Array.isArray(updates)) {
    return {
      ok: false,
      failures: [
        {
          index: 0,
          entityKey: "<result>",
          error: "updates must be an array",
        },
      ],
    };
  }
  if (updates.length > MAX_UPDATES_PER_EVENT) {
    return {
      ok: false,
      failures: [
        {
          index: 0,
          entityKey: "<result>",
          error: `more than ${MAX_UPDATES_PER_EVENT} updates in one event`,
        },
      ],
    };
  }
  const byKey = new Map(entities.map((e) => [e.key, e]));
  const seen = new Set<string>();
  const failures: UpdateCheckFailure[] = [];
  for (const [index, update] of updates.entries()) {
    if (update === null || typeof update !== "object" || Array.isArray(update)) {
      failures.push({
        index,
        entityKey: "<invalid>",
        error: "update must be an object",
      });
      continue;
    }
    if (typeof update.entityKey !== "string") {
      failures.push({ index, entityKey: "<missing>", error: "entityKey must be a string" });
      continue;
    }
    if (seen.has(update.entityKey)) {
      failures.push({ index, entityKey: update.entityKey, error: "duplicate update for one entity" });
      continue;
    }
    seen.add(update.entityKey);
    const descriptor = byKey.get(update.entityKey);
    if (!descriptor) {
      failures.push({ index, entityKey: update.entityKey, error: "entity is not declared by the profile" });
      continue;
    }
    const valueCheck = validateEntityValue(descriptor, update.value);
    if (!valueCheck.ok) {
      failures.push({ index, entityKey: update.entityKey, error: valueCheck.error });
      continue;
    }
    if (!entityValueFits(update.value)) {
      failures.push({ index, entityKey: update.entityKey, error: "value exceeds the serialised size cap" });
      continue;
    }
    if (
      update.sourceTimestamp !== undefined &&
      (typeof update.sourceTimestamp !== "string" || Number.isNaN(Date.parse(update.sourceTimestamp)))
    ) {
      failures.push({ index, entityKey: update.entityKey, error: "sourceTimestamp is not ISO-8601" });
      continue;
    }
    if (update.quality !== undefined &&
        !["good", "bad", "uncertain", "stale", "unknown"].includes(update.quality)) {
      failures.push({ index, entityKey: update.entityKey, error: "quality is invalid" });
      continue;
    }
    if (update.alarm !== undefined && update.alarm !== null) {
      if (typeof update.alarm !== "object" || Array.isArray(update.alarm)) {
        failures.push({ index, entityKey: update.entityKey, error: "alarm must be an object or null" });
        continue;
      }
      if (!(["info", "warning", "critical"] as unknown[]).includes(update.alarm.level)) {
        failures.push({ index, entityKey: update.entityKey, error: "alarm level is invalid" });
        continue;
      }
      if (typeof update.alarm.code !== "string" || update.alarm.code.length === 0 || update.alarm.code.length > 64) {
        failures.push({ index, entityKey: update.entityKey, error: "alarm code is invalid" });
        continue;
      }
    }
    if (update.sequence !== undefined && typeof update.sequence !== "number") {
      failures.push({ index, entityKey: update.entityKey, error: "sequence must be a JSON number" });
      continue;
    }
    if (
      update.sequence !== undefined &&
      (!Number.isSafeInteger(update.sequence) || update.sequence < 0)
    ) {
      failures.push({ index, entityKey: update.entityKey, error: "sequence must be a non-negative safe integer" });
    }
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// ---------------------------------------------------------------------------
// Manifest lookups used by the dispatcher / broker
// ---------------------------------------------------------------------------

export interface ManifestIndex {
  get(pluginId: string): PluginManifest | undefined;
}

export function findEventDescriptor(
  manifest: PluginManifest,
  eventKind: string,
  schemaVersion: number,
) {
  return manifest.events.find(
    (e) => e.kind === eventKind && e.schemaVersion === schemaVersion,
  );
}

export function findProfile(
  manifest: PluginManifest,
  profileId: string,
  profileVersion: number,
) {
  return manifest.profiles.find(
    (p) => p.id === profileId && p.version === profileVersion,
  );
}
