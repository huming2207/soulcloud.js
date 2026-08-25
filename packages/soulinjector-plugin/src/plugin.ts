import { definePlugin, type ActionEncoder, type ActionEncodingContext, type EntityUpdate, type PluginDefinition, type PluginManifest } from "@soulcloud/plugin-sdk";
import type { SoulInjectorRepository, StoreArtifactChunkOutput, TargetConfigRecord } from "./repository";
import { SOULINJECTOR_COMMAND, debugLogSchema, debugStatusSchema } from "./device-protocol";
import { targetSelectionArgs } from "./target-selection";

export const SOULINJECTOR_PLUGIN_ID = "soulcloud.soulinjector-debugger";
export const SOULINJECTOR_PLUGIN_VERSION = "0.1.0";
const profileId = "soulinjector-debugger";
const CLIENT_BUNDLE = `document.querySelector('form')?.addEventListener('submit',()=>{const button=document.querySelector('button[type="submit"]');if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent='Saving…';}});`;

const targetRevision = { type: "integer" as const, required: true, min: 1, max: Number.MAX_SAFE_INTEGER };
const targetId = { type: "string" as const, required: true, maxLength: 64 };
const targetSelection = { targetConfigRevision: targetRevision, targetId };

const actions: PluginManifest["actions"] = [
  { id: "debug.identify", inputSchema: targetSelection, wire: { command: SOULINJECTOR_COMMAND.identify, schemaVersion: 1 } },
  { id: "debug.halt", inputSchema: targetSelection, wire: { command: SOULINJECTOR_COMMAND.halt, schemaVersion: 1 }, requiresHumanApproval: true },
  { id: "debug.resume", inputSchema: targetSelection, wire: { command: SOULINJECTOR_COMMAND.resume, schemaVersion: 1 }, requiresHumanApproval: true },
  { id: "debug.reset", inputSchema: targetSelection, wire: { command: SOULINJECTOR_COMMAND.reset, schemaVersion: 1 }, requiresHumanApproval: true },
  { id: "debug.read_memory", inputSchema: {
    ...targetSelection,
    address: { type: "integer" as const, required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    length: { type: "integer" as const, required: true, min: 1, max: 1_048_576 },
  }, wire: { command: SOULINJECTOR_COMMAND.readMemory, schemaVersion: 1 } },
  { id: "debug.read_registers", inputSchema: targetSelection, wire: { command: SOULINJECTOR_COMMAND.readRegisters, schemaVersion: 1 } },
  { id: "debug.start", inputSchema: {
    ...targetSelection,
    mode: { type: "string" as const, required: true, enum: ["automatic", "assisted"] },
  }, wire: { command: SOULINJECTOR_COMMAND.start, schemaVersion: 1 }, requiresHumanApproval: true },
];

const entities: PluginManifest["profiles"][number]["entities"] = [
  { key: "connection.state", valueType: "enum" as const, category: "primary" as const, enumValues: ["offline", "online", "unknown"] },
  { key: "debug.state", valueType: "enum" as const, category: "primary" as const, enumValues: ["idle", "running", "halted", "failed", "completed", "awaiting_approval"] },
  { key: "debug.progress", valueType: "number" as const, category: "measurement" as const, unit: "%" },
  { key: "debug.target", valueType: "string" as const, category: "diagnostic" as const },
  { key: "debug.session_id", valueType: "string" as const, category: "diagnostic" as const },
  { key: "debug.error", valueType: "string" as const, category: "diagnostic" as const },
  { key: "debug.last_message", valueType: "string" as const, category: "diagnostic" as const },
];

const events = [
  { kind: "debug.status", schemaVersion: 1, description: "Bounded debugger state/progress update from a Soulcloud Device" },
  { kind: "debug.log", schemaVersion: 1, description: "A bounded debugger log line from a Soulcloud Device" },
];

const manifest = {
  id: SOULINJECTOR_PLUGIN_ID,
  version: SOULINJECTOR_PLUGIN_VERSION,
  apiVersion: 1 as const,
  displayName: "SoulInjector Remote Debugger",
  profiles: [{
    id: profileId,
    version: 1,
    manufacturer: "Soulcloud",
    model: "SoulInjector",
    capabilities: ["debugger.swd", "debugger.uart", "debugger.elf"],
    entities,
  }],
  actions,
  events,
  ui: {
    routes: [{
      id: "debugger",
      path: "/debugger",
      methods: ["GET", "POST"] as ("GET" | "POST")[],
      actionSchema: { yaml: { type: "string" as const, required: true, maxLength: 65_536, title: "Target YAML", description: "Target architecture, chip and required debugger primitives" } },
    }],
    assets: [{ path: "/debugger/app.js", contentType: "text/javascript; charset=utf-8" }],
  },
};

interface SoulInjectorPluginStore {
  saveTargetConfig(input: { installationId: string; projectId: string; createdBy: string; yaml: string }): Promise<TargetConfigRecord>;
  getLatestTargetConfig(installationId: string): Promise<TargetConfigRecord | null>;
  getTargetConfig(installationId: string, revision: number): Promise<TargetConfigRecord | null>;
  storeArtifactChunk(input: { installationId: string; projectId: string; userId: string; uploadId: string; kind: "elf" | "firmware"; filename: string; contentType: string; totalSize: number; offset: number; final: boolean; chunk: Uint8Array }): Promise<StoreArtifactChunkOutput>;
}

function value(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("action input must be an object");
  const result = (input as Record<string, unknown>)[key];
  if (result === undefined) throw new Error(`missing action field ${key}`);
  return result;
}

function stringValue(input: unknown, key: string): string {
  const result = value(input, key);
  if (typeof result !== "string") throw new Error(`action field ${key} must be a string`);
  return result;
}

function numberValue(input: unknown, key: string): number {
  const result = value(input, key);
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new Error(`action field ${key} must be a safe integer`);
  return result;
}

function one(name: string, input: unknown): Record<string, string | number> {
  const result = value(input, name);
  if (typeof result !== "string" && (typeof result !== "number" || !Number.isFinite(result))) throw new Error(`action field ${name} has an invalid value`);
  return { [name]: result };
}

function createEncoders(repository: Pick<SoulInjectorRepository, "getTargetConfig">): Record<string, ActionEncoder> {
  const selection = (input: unknown, context: ActionEncodingContext) => targetSelectionArgs(repository, {
    targetConfigRevision: numberValue(input, "targetConfigRevision"),
    targetId: stringValue(input, "targetId"),
  }, context);
  return {
    "debug.identify": selection,
    "debug.halt": selection,
    "debug.resume": selection,
    "debug.reset": selection,
    "debug.read_memory": async (input, context) => [...await selection(input, context), one("address", input), one("length", input)],
    "debug.read_registers": selection,
    "debug.start": async (input, context) => [...await selection(input, context), one("mode", input)],
  };
}

function updateIf<T extends EntityUpdate["value"]>(updates: EntityUpdate[], key: string, value: T): void {
  if (value !== undefined) updates.push({ entityKey: key, value });
}

function eventUpdates(payload: unknown): EntityUpdate[] {
  const parsed = debugStatusSchema.safeParse(payload);
  if (!parsed.success) return [];
  const record = parsed.data;
  const updates: EntityUpdate[] = [];
  updateIf(updates, "debug.state", record.state);
  if (record.connectionState) updateIf(updates, "connection.state", record.connectionState);
  if (record.progress !== undefined) updateIf(updates, "debug.progress", record.progress);
  if (record.target) updateIf(updates, "debug.target", record.target);
  if (record.sessionId) updateIf(updates, "debug.session_id", record.sessionId);
  if (record.error) updateIf(updates, "debug.error", record.error);
  return updates;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function configForm(input: { installationId: string; yaml: string }): string {
  return `<main><h1>SoulInjector debugger</h1><p>Configure the target architecture, chip and required debugger primitives.</p><form method="post"><label for="yaml">Target YAML</label><br><textarea id="yaml" name="yaml" rows="24" cols="100" maxlength="65536" required>${escapeHtml(input.yaml)}</textarea><br><button type="submit">Save target configuration</button></form><script type="module" src="/plugins/${encodeURIComponent(input.installationId)}/assets/debugger/app.js" defer></script></main>`;
}

export function createSoulInjectorPlugin(repository: SoulInjectorPluginStore): PluginDefinition {
  return definePlugin({
    manifest,
    encodeAction: createEncoders(repository),
    onEvent: async (_context, event) => {
      if (event.kind === "debug.status") {
        const parsed = debugStatusSchema.safeParse(event.payload);
        return parsed.success ? { updates: eventUpdates(parsed.data) } : { logs: [{ level: "warn", message: "ignored malformed SoulInjector debug.status event" }] };
      }
      const parsed = debugLogSchema.safeParse(event.payload);
      return parsed.success
        ? { updates: [{ entityKey: "debug.last_message", value: parsed.data.message }], logs: [{ level: parsed.data.level, message: parsed.data.message }] }
        : { logs: [{ level: "warn", message: "ignored malformed SoulInjector debug.log event" }] };
    },
    configureTarget: async (input) => {
      const saved = await repository.saveTargetConfig({ installationId: input.installationId, projectId: input.projectId, createdBy: input.userId, yaml: input.yaml });
      return { configId: saved.id, revision: saved.revision, sha256: saved.sha256, targetCount: saved.config.targets.length };
    },
    storeArtifactChunk: async (input) => repository.storeArtifactChunk(input),
    render: {
      debugger: async (input) => {
        const saved = await repository.getLatestTargetConfig(input.installationId);
        return { html: configForm({ installationId: input.installationId, yaml: saved?.yaml ?? "version: 1\ntargets:\n  - id: example\n    displayName: Example target\n    architecture: cortex-m\n    chip: replace-me\n    transport: swd\n    requiredPrimitives:\n      - identify\n" }), title: "SoulInjector debugger", cache: "no-store" };
      },
    },
    handleAction: {
      debugger: async (action, input) => {
        const yaml = stringValue(action, "yaml");
        await repository.saveTargetConfig({ installationId: input.installationId, projectId: input.projectId, createdBy: input.user.id, yaml });
        return { redirect: `/plugins/${input.installationId}/debugger` };
      },
    },
    assets: {
      "/debugger/app.js": async () => ({ body: new TextEncoder().encode(CLIENT_BUNDLE), contentType: "text/javascript; charset=utf-8", cache: "no-store" }),
    },
  });
}
