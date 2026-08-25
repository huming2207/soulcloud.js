import { z } from "zod";

export const MAX_TARGET_CONFIG_BYTES = 64 * 1024;

/**
 * The primitive names are deliberately a small wire-level vocabulary. A
 * target YAML file can select the primitives required by a target without
 * allowing arbitrary commands to be smuggled into the plugin manifest.
 */
export const DEBUGGER_PRIMITIVES = [
  "identify",
  "read-registers",
  "read-memory",
  "write-memory",
  "halt",
  "resume",
  "reset",
  "breakpoint",
  "watchpoint",
  "stack-trace",
  "flash-read",
  "flash-write",
  "uart-capture",
  "uart-command",
] as const;

export type DebuggerPrimitive = (typeof DEBUGGER_PRIMITIVES)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be a lowercase slug");
const nonEmptyText = z.string().trim().min(1).max(128);

const memoryRegionSchema = z.object({
  name: nonEmptyText,
  start: z.number().safe().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  size: z.number().safe().int().positive().max(0x1_0000_0000),
  permissions: z.string().regex(/^[rwx-]{1,4}$/, "must contain only r, w, x or -"),
}).strict();

const debuggerTargetSchema = z.object({
  id: slug,
  displayName: nonEmptyText,
  architecture: slug,
  chip: nonEmptyText,
  transport: z.enum(["swd", "uart"]),
  requiredPrimitives: z.array(z.enum(DEBUGGER_PRIMITIVES)).min(1).max(DEBUGGER_PRIMITIVES.length),
  memoryRegions: z.array(memoryRegionSchema).max(128).optional(),
}).strict().superRefine((target, context) => {
  const unique = new Set(target.requiredPrimitives);
  if (unique.size !== target.requiredPrimitives.length) {
    context.addIssue({ code: "custom", path: ["requiredPrimitives"], message: "requiredPrimitives must not contain duplicates" });
  }
  if (target.transport === "uart" && target.requiredPrimitives.some((primitive) => ["breakpoint", "watchpoint", "stack-trace"].includes(primitive))) {
    context.addIssue({ code: "custom", path: ["requiredPrimitives"], message: "UART targets cannot require SWD breakpoint, watchpoint, or stack-trace primitives" });
  }
});

export const targetConfigSchema = z.object({
  version: z.literal(1),
  targets: z.array(debuggerTargetSchema).min(1).max(64),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, target] of config.targets.entries()) {
    if (ids.has(target.id)) context.addIssue({ code: "custom", path: ["targets", index, "id"], message: "target id must be unique" });
    ids.add(target.id);
  }
});

export type DebuggerTarget = z.infer<typeof debuggerTargetSchema>;
export type TargetConfig = z.infer<typeof targetConfigSchema>;

export class TargetConfigError extends Error {
  readonly code = "INVALID_TARGET_CONFIG" as const;

  constructor(message: string) {
    super(message);
    this.name = "TargetConfigError";
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatValidationError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

function rejectAmbiguousYaml(yaml: string): void {
  if (/^\s*(?:---|\.\.\.)\s*$/m.test(yaml)) throw new TargetConfigError("multiple YAML documents are not supported");
  if (/(^|[\s:[,{-])[*&][A-Za-z0-9_-]+/.test(yaml)) throw new TargetConfigError("YAML anchors and aliases are not supported");

  // Bun's built-in YAML parser intentionally keeps a small API surface and
  // uses last-key-wins for duplicate mappings. Reject duplicate mapping keys
  // at the same indentation before parsing so an operator never signs an
  // ambiguous configuration by accident.
  const scopes: Array<{ indent: number; listItem: boolean; keys: Set<string> }> = [];
  const enterScope = (indent: number, listItem: boolean): Set<string> => {
    while (scopes.length > 0 && scopes[scopes.length - 1]!.indent > indent) scopes.pop();
    const current = scopes[scopes.length - 1];
    if (current && current.indent === indent && listItem && current.listItem) scopes.pop();
    const next = scopes[scopes.length - 1];
    if (!next || next.indent !== indent) {
      const created = { indent, listItem, keys: new Set<string>() };
      scopes.push(created);
      return created.keys;
    }
    return next.keys;
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const listItem = /^(\s*)-\s*(.*)$/.exec(line);
    const match = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line);
    if (!match) {
      if (listItem) enterScope(listItem[1]!.replace(/\t/g, "  ").length, true);
      continue;
    }
    const indent = match[1]!.replace(/\t/g, "  ").length;
    const isListItem = /^\s*-\s+/.test(line);
    const keys = enterScope(indent, isListItem);
    if (keys.has(match[2]!)) throw new TargetConfigError(`duplicate YAML key: ${match[2]}`);
    keys.add(match[2]!);
  }
}

/** Parse and validate the complete YAML document received from an operator. */
export function parseTargetConfigYaml(yaml: string): TargetConfig {
  if (typeof yaml !== "string" || yaml.trim().length === 0) throw new TargetConfigError("configuration must not be empty");
  if (utf8ByteLength(yaml) > MAX_TARGET_CONFIG_BYTES) throw new TargetConfigError(`configuration exceeds ${MAX_TARGET_CONFIG_BYTES} bytes`);
  rejectAmbiguousYaml(yaml);
  let value: unknown;
  try {
    value = Bun.YAML.parse(yaml);
  } catch (error) {
    throw new TargetConfigError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = targetConfigSchema.safeParse(value);
  if (!result.success) throw new TargetConfigError(formatValidationError(result.error));
  return result.data;
}

/** Stable JSON used for deduplication and audit hashes. */
export function canonicalTargetConfig(config: TargetConfig): string {
  const visit = (value: unknown): string => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TargetConfigError("configuration contains a non-finite number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(visit).join(",")}]`;
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${visit(entry)}`).join(",")}}`;
    }
    throw new TargetConfigError("configuration contains an unsupported value");
  };
  return visit(config);
}

export async function targetConfigHash(config: TargetConfig): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalTargetConfig(config)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
