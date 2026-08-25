import { definePlugin, type ActionEncoder, type ActionEncodingContext, type EntityUpdate, type PluginDefinition, type PluginEventOutput, type PluginManifest } from "@soulcloud/plugin-sdk";
import { DebugSessionNotAvailableError } from "./repository";
import type { AppendDebugObservationInput, CreateDebugCaseInput, DebugArtifactRecord, DebugCaseRecord, DebugObservationRecord, DebugSessionRecord, SoulInjectorRepository, StoreArtifactChunkOutput, TargetConfigRecord, TargetConfigSummary, UpdateDebugSessionStateInput } from "./repository";
import { SOULINJECTOR_COMMAND, debugLogSchema, debugStatusSchema } from "./device-protocol";
import { targetSelectionArgs } from "./target-selection";
import { TargetConfigError } from "./target-config";

export const SOULINJECTOR_PLUGIN_ID = "soulcloud.soulinjector-debugger";
export const SOULINJECTOR_PLUGIN_VERSION = "0.1.0";
const profileId = "soulinjector-debugger";
const CLIENT_BUNDLE = `document.querySelector('form')?.addEventListener('submit',()=>{const button=document.querySelector('button[type="submit"]');if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent='Saving…';}});const fileInput=document.getElementById('yaml-file');const yamlInput=document.getElementById('yaml');async function loadYamlFile(){if(!(fileInput instanceof HTMLInputElement)||!(yamlInput instanceof HTMLTextAreaElement))return;const file=fileInput.files?.[0];if(!file||file.size>65536)return;yamlInput.value=await file.text();}if(fileInput instanceof HTMLInputElement)fileInput.addEventListener('change',loadYamlFile);const artifactForm=document.getElementById('artifact-upload');const artifactFile=document.getElementById('artifact-file');const artifactKind=document.getElementById('artifact-kind');const artifactStatus=document.getElementById('artifact-upload-status');const artifactInstallation=location.pathname.split('/')[2]??'';function setArtifactStatus(message){if(artifactStatus instanceof HTMLElement)artifactStatus.textContent=message;}async function uploadArtifact(event){event.preventDefault();if(!(artifactFile instanceof HTMLInputElement)||!(artifactKind instanceof HTMLSelectElement))return;const file=artifactFile.files?.[0];const kind=artifactKind.value;if(!file||(kind!=='elf'&&kind!=='firmware')){setArtifactStatus('Choose a file and artifact type.');return;}if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name)){setArtifactStatus('Filename must use letters, numbers, dot, dash or underscore.');return;}const contentType=file.type||(kind==='elf'?'application/x-elf':'application/octet-stream');const url='/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger/artifacts?kind='+encodeURIComponent(kind)+'&filename='+encodeURIComponent(file.name)+'&content_type='+encodeURIComponent(contentType);setArtifactStatus('Uploading…');try{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream','idempotency-key':crypto.randomUUID(),'x-soulcloud-content-length':String(file.size)},body:file});if(!response.ok){setArtifactStatus('Upload failed ('+response.status+')');return;}setArtifactStatus('Upload complete');location.reload();}catch{setArtifactStatus('Upload failed');}}if(artifactForm instanceof HTMLFormElement)artifactForm.addEventListener('submit',uploadArtifact);`;
const CLIENT_BUNDLE_PATH = "/debugger/app.fcc6ca073712cbca90ecdff0191cfc5e83723c0edbd085b1d288710ded7107c9.js";
const CLIENT_BUNDLE_SHA256 = "fcc6ca073712cbca90ecdff0191cfc5e83723c0edbd085b1d288710ded7107c9";
const MAX_TIMELINE_OBSERVATIONS = 16;
const MAX_OBSERVATION_DATA_CHARS = 2_048;

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
      querySchema: {
        session_id: { type: "string" as const, maxLength: 64, title: "Debugger session" },
        error: { type: "string" as const, enum: ["invalid_target_config"], title: "UI error" },
      },
      actionSchema: {
        intent: { type: "string" as const, required: true, enum: ["save_target", "create_case"], title: "Action" },
        yaml: { type: "string" as const, maxLength: 65_536, title: "Target YAML", description: "Target architecture, chip and required debugger primitives" },
        title: { type: "string" as const, maxLength: 256, title: "Case title" },
        targetUnitRef: { type: "string" as const, maxLength: 256, title: "Target unit reference" },
      },
    }],
    assets: [{ path: CLIENT_BUNDLE_PATH, contentType: "text/javascript; charset=utf-8", sha256: CLIENT_BUNDLE_SHA256 }],
  },
};

interface SoulInjectorPluginStore {
  saveTargetConfig(input: { installationId: string; projectId: string; createdBy: string; yaml: string }): Promise<TargetConfigRecord>;
  createDebugCase?(input: CreateDebugCaseInput): Promise<DebugCaseRecord>;
  listDebugCases?(projectId: string, limit?: number): Promise<DebugCaseRecord[]>;
  listDebugSessions?(installationId: string, projectId: string, limit?: number): Promise<DebugSessionRecord[]>;
  getDebugSession?(id: string, installationId: string, projectId: string): Promise<DebugSessionRecord | null>;
  listDebugObservations?(sessionId: string, installationId: string, projectId: string, limit?: number): Promise<DebugObservationRecord[]>;
  appendDebugObservation?(input: AppendDebugObservationInput): Promise<unknown>;
  updateDebugSessionState?(input: UpdateDebugSessionStateInput): Promise<DebugSessionRecord>;
  createDebugSession?(input: Parameters<SoulInjectorRepository["createDebugSession"]>[0]): Promise<DebugSessionRecord>;
  abortDebugSession?(id: string | null, executionRef: string, installationId: string, projectId: string, soulcloudDeviceRef: string): Promise<DebugSessionRecord | null>;
  getLatestTargetConfig(installationId: string): Promise<TargetConfigRecord | null>;
  getTargetConfig(installationId: string, revision: number): Promise<TargetConfigRecord | null>;
  listTargetConfigs?(installationId: string, projectId: string): Promise<TargetConfigSummary[]>;
  listArtifacts?(installationId: string, projectId: string): Promise<DebugArtifactRecord[]>;
  storeArtifactChunk(input: { installationId: string; projectId: string; userId: string; uploadId: string; caseId?: string; kind: "elf" | "firmware"; filename: string; contentType: string; totalSize: number; offset: number; final: boolean; chunk: Uint8Array }): Promise<StoreArtifactChunkOutput>;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sessionStateForDeviceState(state: string): Exclude<UpdateDebugSessionStateInput["state"], "paused"> | null {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "running" || state === "halted" || state === "awaiting_approval") return "active";
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function observationData(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = "[unserializable]";
  }
  return escapeHtml(serialized.length > MAX_OBSERVATION_DATA_CHARS ? `${serialized.slice(0, MAX_OBSERVATION_DATA_CHARS)}…` : serialized);
}

function configForm(input: { installationId: string; yaml: string; cases: DebugCaseRecord[]; sessions: DebugSessionRecord[]; selectedSession: DebugSessionRecord | null; observations: DebugObservationRecord[]; targetConfigs: TargetConfigSummary[]; artifacts: DebugArtifactRecord[]; error?: string }): string {
  const cases = input.cases.length === 0
    ? "<p>No debugger cases yet.</p>"
    : `<ul>${input.cases.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.state)}${item.targetUnitRef ? ` — ${escapeHtml(item.targetUnitRef)}` : ""}</li>`).join("")}</ul>`;
  const sessions = input.sessions.length === 0
    ? "<p>No debugger sessions yet.</p>"
    : `<ul>${input.sessions.map((item) => `<li><a href="?session_id=${encodeURIComponent(item.id)}"><code>${escapeHtml(item.id)}</code></a> — ${escapeHtml(item.state)} — device <code>${escapeHtml(item.soulcloudDeviceRef)}</code> — started ${escapeHtml(item.startedAt)}</li>`).join("")}</ul>`;
  const timeline = !input.selectedSession
    ? "<p>Select a debugger session to view its timeline.</p>"
    : input.observations.length === 0
      ? `<p>No observations recorded for session <code>${escapeHtml(input.selectedSession.id)}</code>.</p>`
      : `<ol>${input.observations.map((item) => `<li><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(item.createdAt)}</time> — <strong>${escapeHtml(item.source)}:${escapeHtml(item.kind)}</strong><pre>${observationData(item.structuredData)}</pre></li>`).join("")}</ol>`;
  const targetConfigs = input.targetConfigs.length === 0
    ? "<p>No target configuration revisions yet.</p>"
    : `<ul>${input.targetConfigs.map((item) => `<li><strong>Revision ${item.revision}</strong> — ${item.targetCount} target(s) — <code>${escapeHtml(item.sha256)}</code> — created ${escapeHtml(item.createdAt)}</li>`).join("")}</ul>`;
  const artifacts = input.artifacts.length === 0
    ? "<p>No ELF or firmware artifacts yet.</p>"
    : `<ul>${input.artifacts.map((item) => `<li><strong>${escapeHtml(item.kind)}</strong> — ${escapeHtml(item.filename)} — ${item.size} bytes — <code>${escapeHtml(item.id)}</code> — SHA-256 <code>${escapeHtml(item.sha256)}</code> — ${observationData(item.metadata)}</li>`).join("")}</ul>`;
  const error = input.error === "invalid_target_config" ? "<p role=\"alert\">Target configuration is invalid. Review the YAML schema and try again.</p>" : "";
  return `<main><h1>SoulInjector debugger</h1>${error}<section><h2>Cases</h2>${cases}<form method="post"><input type="hidden" name="intent" value="create_case"><label for="case-title">New case title</label><br><input id="case-title" name="title" maxlength="256" required><br><label for="target-unit-ref">Target unit reference</label><br><input id="target-unit-ref" name="targetUnitRef" maxlength="256"><br><button type="submit">Create case</button></form></section><section><h2>Sessions</h2>${sessions}</section><section><h2>Session timeline</h2>${timeline}</section><section><h2>Artifacts</h2>${artifacts}<form id="artifact-upload" method="post" action="/plugins/${encodeURIComponent(input.installationId)}/debugger/artifacts"><label for="artifact-kind">Artifact type</label><br><select id="artifact-kind"><option value="elf">ELF</option><option value="firmware">Firmware</option></select><br><label for="artifact-file">Artifact file (max 64 MiB)</label><br><input id="artifact-file" type="file" accept=".elf,.bin,.img,application/octet-stream,application/x-elf" required><br><button type="submit">Upload artifact</button><p id="artifact-upload-status" role="status" aria-live="polite"></p></form></section><section><h2>Target configuration</h2><p>Configure the target architecture, chip and required debugger primitives.</p><h3>Saved revisions</h3>${targetConfigs}<form method="post"><input type="hidden" name="intent" value="save_target"><label for="yaml-file">Load YAML file (最大 64 KiB)</label><br><input id="yaml-file" type="file" accept=".yaml,.yml,text/yaml,text/plain"><br><label for="yaml">Target YAML</label><br><textarea id="yaml" name="yaml" rows="24" cols="100" maxlength="65536" required>${escapeHtml(input.yaml)}</textarea><br><button type="submit">Save target configuration</button></form></section><script type="module" src="/plugins/${encodeURIComponent(input.installationId)}/assets${CLIENT_BUNDLE_PATH}" defer></script></main>`;
}

export function createSoulInjectorPlugin(repository: SoulInjectorPluginStore): PluginDefinition {
  return definePlugin({
    manifest,
    encodeAction: createEncoders(repository),
    onEvent: async (context, event) => {
      if (event.kind === "debug.status") {
        const parsed = debugStatusSchema.safeParse(event.payload);
        if (!parsed.success) return { logs: [{ level: "warn", message: "ignored malformed SoulInjector debug.status event" }] };
        if (parsed.data.sessionId && isUuid(parsed.data.sessionId)) {
          const logs: NonNullable<PluginEventOutput["logs"]> = [];
          let sessionAvailable = true;
          if (repository.updateDebugSessionState) {
            const state = sessionStateForDeviceState(parsed.data.state);
            if (state) {
              try {
                await repository.updateDebugSessionState({ installationId: context.installation.id, projectId: context.installation.projectId, sessionId: parsed.data.sessionId, soulcloudDeviceRef: context.device.id, state });
              } catch (error) {
                if (!(error instanceof DebugSessionNotAvailableError)) throw error;
                sessionAvailable = false;
                logs.push({ level: "warn", message: "ignored SoulInjector event for an unavailable debug session" });
              }
            }
          }
          if (sessionAvailable && repository.appendDebugObservation) {
            try {
              await repository.appendDebugObservation({ installationId: context.installation.id, projectId: context.installation.projectId, sessionId: parsed.data.sessionId, soulcloudDeviceRef: context.device.id, eventRef: event.id, source: "device", kind: event.kind, structuredData: parsed.data });
            } catch (error) {
              if (!(error instanceof DebugSessionNotAvailableError)) throw error;
              logs.push({ level: "warn", message: "ignored SoulInjector event for an unavailable debug session" });
            }
          }
          return { updates: eventUpdates(parsed.data), ...(logs.length > 0 ? { logs } : {}) };
        }
        return { updates: eventUpdates(parsed.data) };
      }
      const parsed = debugLogSchema.safeParse(event.payload);
      if (!parsed.success) return { logs: [{ level: "warn", message: "ignored malformed SoulInjector debug.log event" }] };
      if (parsed.data.sessionId && isUuid(parsed.data.sessionId)) {
        if (repository.appendDebugObservation) {
          try {
            await repository.appendDebugObservation({ installationId: context.installation.id, projectId: context.installation.projectId, sessionId: parsed.data.sessionId, soulcloudDeviceRef: context.device.id, eventRef: event.id, source: "device", kind: event.kind, structuredData: parsed.data });
          } catch (error) {
            if (!(error instanceof DebugSessionNotAvailableError)) throw error;
            return { updates: [{ entityKey: "debug.last_message", value: parsed.data.message }], logs: [{ level: "warn", message: "ignored SoulInjector log for an unavailable debug session" }] };
          }
        }
      }
      return { updates: [{ entityKey: "debug.last_message", value: parsed.data.message }], logs: [{ level: parsed.data.level, message: parsed.data.message }] };
    },
    configureTarget: async (input) => {
      const saved = await repository.saveTargetConfig({ installationId: input.installationId, projectId: input.projectId, createdBy: input.userId, yaml: input.yaml });
      return { configId: saved.id, revision: saved.revision, sha256: saved.sha256, targetCount: saved.config.targets.length };
    },
    startDebugSession: async (input) => {
      if (!repository.createDebugSession) throw new Error("debug session persistence is not available");
      const session = await repository.createDebugSession({
        installationId: input.installationId,
        projectId: input.projectId,
        caseId: input.caseId,
        soulcloudDeviceRef: input.deviceId,
        executionRef: input.executionId,
        pluginVersion: input.pluginVersion,
        manifestHash: input.manifestHash,
        deviceFirmwareVersion: input.deviceFirmwareVersion,
        targetConfigId: input.targetConfigId,
        targetConfigRevision: input.targetConfigRevision,
        targetId: input.targetId,
        artifactId: input.artifactId,
        startedBy: input.userId,
      });
      return { sessionId: session.id, executionId: input.executionId };
    },
    abortDebugSession: async (input) => {
      if (!repository.abortDebugSession) throw new Error("debug session cleanup is not available");
      const session = await repository.abortDebugSession(input.sessionId ?? null, input.executionId, input.installationId, input.projectId, input.deviceId);
      if (!session) throw new DebugSessionNotAvailableError();
      return { sessionId: session.id, executionId: input.executionId, state: "failed" };
    },
    listTargetConfigs: async (input) => repository.listTargetConfigs
      ? repository.listTargetConfigs(input.installationId, input.projectId)
      : [],
    listArtifacts: async (input) => {
      if (!repository.listArtifacts) return [];
      return (await repository.listArtifacts(input.installationId, input.projectId)).map((artifact) => ({
        artifactId: artifact.id,
        kind: artifact.kind,
        filename: artifact.filename,
        contentType: artifact.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
        metadata: artifact.metadata,
        createdAt: artifact.createdAt,
      }));
    },
    storeArtifactChunk: async (input) => repository.storeArtifactChunk({ ...input, caseId: input.caseId }),
    render: {
      debugger: async (input) => {
        const [saved, cases, sessions, targetConfigs, artifacts] = await Promise.all([
          repository.getLatestTargetConfig(input.installationId),
          repository.listDebugCases ? repository.listDebugCases(input.projectId, 64) : Promise.resolve([] as DebugCaseRecord[]),
          repository.listDebugSessions ? repository.listDebugSessions(input.installationId, input.projectId, 64) : Promise.resolve([] as DebugSessionRecord[]),
          repository.listTargetConfigs ? repository.listTargetConfigs(input.installationId, input.projectId) : Promise.resolve([] as TargetConfigSummary[]),
          repository.listArtifacts ? repository.listArtifacts(input.installationId, input.projectId) : Promise.resolve([] as DebugArtifactRecord[]),
        ]);
        const selectedId = typeof input.params.session_id === "string" && isUuid(input.params.session_id) ? input.params.session_id : null;
        const selectedSession = selectedId && repository.getDebugSession
          ? await repository.getDebugSession(selectedId, input.installationId, input.projectId)
          : null;
        const observations = selectedSession && repository.listDebugObservations
          ? await repository.listDebugObservations(selectedSession.id, input.installationId, input.projectId, MAX_TIMELINE_OBSERVATIONS)
          : [];
        const error = typeof input.params.error === "string" ? input.params.error : undefined;
        return { html: configForm({ installationId: input.installationId, yaml: saved?.yaml ?? "version: 1\ntargets:\n  - id: example\n    displayName: Example target\n    architecture: cortex-m\n    chip: replace-me\n    transport: swd\n    requiredPrimitives:\n      - identify\n", cases, sessions, selectedSession, observations, targetConfigs, artifacts, error }), title: "SoulInjector debugger", cache: "no-store" };
      },
    },
    handleAction: {
      debugger: async (action, input) => {
        const intent = stringValue(action, "intent");
        if (intent === "create_case") {
          if (!repository.createDebugCase) throw new Error("debug case persistence is not available");
          const title = stringValue(action, "title");
          const targetUnitRef = typeof action === "object" && action !== null && !Array.isArray(action) && typeof (action as Record<string, unknown>).targetUnitRef === "string"
            ? (action as Record<string, unknown>).targetUnitRef as string
            : null;
          await repository.createDebugCase({ projectId: input.projectId, targetUnitRef, title, createdBy: input.user.id });
        } else if (intent === "save_target") {
          const yaml = stringValue(action, "yaml");
          try {
            await repository.saveTargetConfig({ installationId: input.installationId, projectId: input.projectId, createdBy: input.user.id, yaml });
          } catch (error) {
            if (error instanceof TargetConfigError) return { redirect: `/plugins/${input.installationId}/debugger?error=invalid_target_config` };
            throw error;
          }
        } else {
          throw new Error("unknown debugger UI action");
        }
        return { redirect: `/plugins/${input.installationId}/debugger` };
      },
    },
    assets: {
      [CLIENT_BUNDLE_PATH]: async () => ({ body: new TextEncoder().encode(CLIENT_BUNDLE), contentType: "text/javascript; charset=utf-8", cache: { maxAgeSeconds: 31_536_000 } }),
    },
  });
}
