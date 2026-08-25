import { definePlugin, type ActionEncoder, type ActionEncodingContext, type EntityUpdate, type PluginDefinition, type PluginEventOutput, type PluginManifest } from "@soulcloud/plugin-sdk";
import { DebugSessionNotAvailableError } from "./repository";
import type { AppendDebugObservationInput, AppendDebugReportRevisionInput, CreateDebugCaseInput, CreateDebugReportInput, DebugArtifactRecord, DebugCaseRecord, DebugObservationRecord, DebugReportRecord, DebugSessionRecord, ReadArtifactChunkOutput, SoulInjectorRepository, StoreArtifactChunkOutput, TargetConfigRecord, TargetConfigSummary, UpdateDebugSessionStateInput } from "./repository";
import { SOULINJECTOR_COMMAND, debugLogSchema, debugStatusSchema } from "./device-protocol";
import { targetSelectionArgs } from "./target-selection";
import { TargetConfigError } from "./target-config";

export const SOULINJECTOR_PLUGIN_ID = "soulcloud.soulinjector-debugger";
export const SOULINJECTOR_PLUGIN_VERSION = "0.1.0";
const profileId = "soulinjector-debugger";
const CLIENT_BUNDLE = `
document.querySelector('form')?.addEventListener('submit',()=>{const button=document.querySelector('button[type="submit"]');if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent='Saving…';}});
const fileInput=document.getElementById('yaml-file');
const yamlInput=document.getElementById('yaml');
async function loadYamlFile(){if(!(fileInput instanceof HTMLInputElement)||!(yamlInput instanceof HTMLTextAreaElement))return;const file=fileInput.files?.[0];if(!file||file.size>65536)return;yamlInput.value=await file.text();}
if(fileInput instanceof HTMLInputElement)fileInput.addEventListener('change',loadYamlFile);
const artifactForm=document.getElementById('artifact-upload');
const artifactFile=document.getElementById('artifact-file');
const artifactKind=document.getElementById('artifact-kind');
const artifactCase=document.getElementById('artifact-case');
const artifactStatus=document.getElementById('artifact-upload-status');
const artifactInstallation=location.pathname.split('/')[2]??'';
function setArtifactStatus(message){if(artifactStatus instanceof HTMLElement)artifactStatus.textContent=message;}
async function sendArtifactUpload(url,file,uploadId){return await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream','idempotency-key':uploadId,'x-soulcloud-content-length':String(file.size)},body:file});}
async function uploadArtifact(event){event.preventDefault();if(!(artifactFile instanceof HTMLInputElement)||!(artifactKind instanceof HTMLSelectElement))return;const file=artifactFile.files?.[0];const kind=artifactKind.value;if(!file||(kind!=='elf'&&kind!=='firmware')){setArtifactStatus('Choose a file and artifact type.');return;}if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name)){setArtifactStatus('Filename must use letters, numbers, dot, dash or underscore.');return;}const contentType=file.type||(kind==='elf'?'application/x-elf':'application/octet-stream');const selectedCase=artifactCase instanceof HTMLSelectElement?artifactCase.value:'';const caseQuery=selectedCase?'&case_id='+encodeURIComponent(selectedCase):'';const url='/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger/artifacts?kind='+encodeURIComponent(kind)+'&filename='+encodeURIComponent(file.name)+'&content_type='+encodeURIComponent(contentType)+caseQuery;const uploadId=crypto.randomUUID();setArtifactStatus('Uploading…');let response;try{response=await sendArtifactUpload(url,file,uploadId);}catch{setArtifactStatus('Retrying…');try{response=await sendArtifactUpload(url,file,uploadId);}catch{setArtifactStatus('Upload failed');return;}}if(!response.ok){setArtifactStatus('Upload failed ('+response.status+')');return;}setArtifactStatus('Upload complete');location.reload();}
if(artifactForm instanceof HTMLFormElement)artifactForm.addEventListener('submit',uploadArtifact);
const actionForm=document.getElementById('debug-actions');
const actionStatus=document.getElementById('debug-action-status');
function setActionStatus(message){if(actionStatus instanceof HTMLElement)actionStatus.textContent=message;}
function actionInput(action){if(!(actionForm instanceof HTMLFormElement))return null;const revision=Number(actionForm.dataset.targetConfigRevision);const targetId=actionForm.dataset.targetId;if(!Number.isSafeInteger(revision)||revision<1||typeof targetId!=='string'||targetId.length===0)return null;const input={targetConfigRevision:revision,targetId:targetId};if(action==='debug.start'){const mode=document.getElementById('debug-start-mode');input.mode=mode instanceof HTMLSelectElement&&mode.value==='assisted'?'assisted':'automatic';}if(action==='debug.read_memory'){const addressField=document.getElementById('debug-memory-address');const lengthField=document.getElementById('debug-memory-length');const address=addressField instanceof HTMLInputElement?Number(addressField.value):NaN;const length=lengthField instanceof HTMLInputElement?Number(lengthField.value):NaN;if(!Number.isSafeInteger(address)||address<0||!Number.isSafeInteger(length)||length<1||length>1048576){return null;}input.address=address;input.length=length;}return input;}
async function submitDebugAction(event){event.preventDefault();if(!(actionForm instanceof HTMLFormElement))return;const button=event.submitter;if(!(button instanceof HTMLButtonElement))return;const action=button.dataset.debugAction;if(typeof action!=='string'||action.length===0)return;const input=actionInput(action);const deviceId=actionForm.dataset.deviceId;const executionId=actionForm.dataset.executionId;if(!input||typeof deviceId!=='string'||deviceId.length===0||typeof executionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(executionId)){setActionStatus('The selected session has no active execution lease.');return;}button.disabled=true;setActionStatus('Submitting action…');try{const response=await fetch('/plugins/'+encodeURIComponent(artifactInstallation)+'/actions/'+encodeURIComponent(action),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:deviceId,executionId:executionId,input:input})});if(!response.ok){setActionStatus('Action failed ('+response.status+').');return;}const result=await response.json();setActionStatus('Queued command '+String(result.batchId??'')+'.');}catch{setActionStatus('Action request failed.');}finally{button.disabled=false;}}
if(actionForm instanceof HTMLFormElement)actionForm.addEventListener('submit',submitDebugAction);
const releaseButton=document.getElementById('debug-release-execution');
async function releaseDebugExecution(){if(!(releaseButton instanceof HTMLButtonElement))return;const executionId=releaseButton.dataset.executionId;if(typeof executionId!=='string'||executionId.length===0){setActionStatus('The selected session has no active execution lease.');return;}releaseButton.disabled=true;setActionStatus('Releasing device lease…');try{const response=await fetch('/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger/executions/'+encodeURIComponent(executionId)+'/release',{method:'POST'});if(!response.ok){setActionStatus('Lease release failed ('+response.status+').');return;}setActionStatus('Device lease released.');location.reload();}catch{setActionStatus('Lease release request failed.');}finally{releaseButton.disabled=false;}}
if(releaseButton instanceof HTMLButtonElement)releaseButton.addEventListener('click',()=>{void releaseDebugExecution();});
const sessionForm=document.getElementById('debug-session-create');
const sessionStatus=document.getElementById('debug-session-status');
function setSessionStatus(message){if(sessionStatus instanceof HTMLElement)sessionStatus.textContent=message;}
async function createDebugSession(event){event.preventDefault();if(!(sessionForm instanceof HTMLFormElement))return;const deviceField=document.getElementById('debug-session-device');const caseField=document.getElementById('debug-session-case');const targetConfigField=document.getElementById('debug-session-target-config');const targetIdField=document.getElementById('debug-session-target-id');const artifactField=document.getElementById('debug-session-artifact');const deviceId=deviceField instanceof HTMLInputElement?deviceField.value.trim():'';const caseId=caseField instanceof HTMLSelectElement?caseField.value:'';if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(caseId)){setSessionStatus('Enter a valid device and case.');return;}const body={deviceId:deviceId,caseId:caseId};const targetConfig=targetConfigField instanceof HTMLSelectElement?targetConfigField.selectedOptions[0]:undefined;if(targetConfig?.value){const revision=Number(targetConfig.dataset.revision);const targetId=targetIdField instanceof HTMLInputElement?targetIdField.value.trim():'';if(!Number.isSafeInteger(revision)||revision<1||targetId.length===0){setSessionStatus('Choose a target configuration and enter its target ID.');return;}body.targetConfigId=targetConfig.value;body.targetConfigRevision=revision;body.targetId=targetId;}const artifactId=artifactField instanceof HTMLSelectElement?artifactField.value:'';if(artifactId)body.artifactId=artifactId;setSessionStatus('Starting debugger session…');try{const response=await fetch('/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json().catch(()=>({}));if(!response.ok){setSessionStatus('Session start failed ('+response.status+').');return;}if(typeof result.sessionId!=='string'){setSessionStatus('Session start returned an invalid result.');return;}location.href='/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger?session_id='+encodeURIComponent(result.sessionId);}catch{setSessionStatus('Session start request failed.');}}
if(sessionForm instanceof HTMLFormElement)sessionForm.addEventListener('submit',createDebugSession);
const commandTimeline=document.getElementById('debug-command-timeline');
async function refreshCommandTimeline(){if(!(commandTimeline instanceof HTMLElement))return;const executionId=commandTimeline.dataset.executionId;if(typeof executionId!=='string'||executionId.length===0)return;try{const response=await fetch('/plugins/'+encodeURIComponent(artifactInstallation)+'/debugger/executions/'+encodeURIComponent(executionId)+'/commands');if(!response.ok)return;const commands=await response.json();if(!Array.isArray(commands))return;const list=document.createElement('ol');for(const command of commands){if(!command||typeof command!=='object')continue;const item=document.createElement('li');const record=command;item.textContent='batch '+String(record.batchId??'')+' — '+String(record.state??'')+(record.resultCode===null||record.resultCode===undefined?'':' — result '+String(record.resultCode));list.appendChild(item);}commandTimeline.replaceChildren(list);}catch{} }
if(commandTimeline instanceof HTMLElement){void refreshCommandTimeline();window.setInterval(()=>{void refreshCommandTimeline();},5000);}
`;
const CLIENT_BUNDLE_PATH = "/debugger/app.7cb731b6fe819bf29c7c12aa9f3d387ce300e1a882ed888bd25a68538d72cfd9.js";
const CLIENT_BUNDLE_SHA256 = "7cb731b6fe819bf29c7c12aa9f3d387ce300e1a882ed888bd25a68538d72cfd9";
const MAX_TIMELINE_OBSERVATIONS = 16;
const MAX_OBSERVATION_DATA_CHARS = 2_048;

const targetRevision = { type: "integer" as const, required: true, min: 1, max: Number.MAX_SAFE_INTEGER };
const targetId = { type: "string" as const, required: true, maxLength: 64 };
// These optional fields are output-side target snapshots. The encoder ignores
// user-supplied values and always reloads them from the selected immutable
// target-config revision before sending a device command.
const targetSelection = {
  targetConfigRevision: targetRevision,
  targetId,
  architecture: { type: "string" as const, maxLength: 64 },
  chip: { type: "string" as const, maxLength: 128 },
  transport: { type: "string" as const, enum: ["swd", "uart"] },
  requiredPrimitives: { type: "string" as const, maxLength: 2_048 },
};

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
        intent: { type: "string" as const, required: true, enum: ["save_target", "create_case", "create_report", "append_report", "finalize_report"], title: "Action" },
        yaml: { type: "string" as const, maxLength: 65_536, title: "Target YAML", description: "Target architecture, chip and required debugger primitives" },
        title: { type: "string" as const, maxLength: 256, title: "Case title" },
        targetUnitRef: { type: "string" as const, maxLength: 256, title: "Target unit reference" },
        caseId: { type: "string" as const, maxLength: 64, title: "Debugger case" },
        reportId: { type: "string" as const, maxLength: 64, title: "Debug report" },
        reportTitle: { type: "string" as const, maxLength: 256, title: "Report title" },
        reportContent: { type: "string" as const, maxLength: 65_536, title: "Report content" },
      },
    }],
    assets: [{ path: CLIENT_BUNDLE_PATH, contentType: "text/javascript; charset=utf-8", sha256: CLIENT_BUNDLE_SHA256 }],
  },
};

interface SoulInjectorPluginStore {
  saveTargetConfig(input: { installationId: string; projectId: string; createdBy: string; yaml: string }): Promise<TargetConfigRecord>;
  createDebugCase?(input: CreateDebugCaseInput): Promise<DebugCaseRecord>;
  listDebugCases?(projectId: string, limit?: number): Promise<DebugCaseRecord[]>;
  createDebugReport?(input: CreateDebugReportInput): Promise<DebugReportRecord>;
  appendDebugReportRevision?(input: AppendDebugReportRevisionInput): Promise<unknown>;
  finalizeDebugReport?(reportId: string, projectId: string): Promise<DebugReportRecord | null>;
  listDebugReports?(projectId: string, limit?: number): Promise<DebugReportRecord[]>;
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
  readArtifactChunk?(id: string, installationId: string, projectId: string, offset: number, length: number): Promise<ReadArtifactChunkOutput | null>;
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

function executionStateForDeviceState(state: string): "completed" | "failed" | null {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
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

function latestSessionError(observations: DebugObservationRecord[]): string | null {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    if (observation.kind === "debug.status") {
      const parsed = debugStatusSchema.safeParse(observation.structuredData);
      if (parsed.success && parsed.data.error) return parsed.data.error;
    }
    if (observation.kind === "debug.log") {
      const parsed = debugLogSchema.safeParse(observation.structuredData);
      if (parsed.success && parsed.data.level === "error") return parsed.data.message;
    }
  }
  return null;
}

function debuggerActionControls(input: { selectedSession: DebugSessionRecord | null }): string {
  const session = input.selectedSession;
  if (!session) return "<section><h2>Manual debugger actions</h2><p>Select a session before issuing a device command.</p></section>";
  const commandTimeline = session.executionRef
    ? `<section id="debug-command-timeline" data-execution-id="${escapeHtml(session.executionRef)}"><h2>Command timeline</h2><p>Loading command status…</p></section>`
    : "";
  if (session.state !== "active") {
    return `${commandTimeline}<section><h2>Manual debugger actions</h2><p>Session is ${escapeHtml(session.state)}; device actions are disabled.</p></section>`;
  }
  const executionRef = session.executionRef;
  if (executionRef === null) {
    return `${commandTimeline}<section><h2>Manual debugger actions</h2><p>This session has no active execution lease; device actions are disabled.</p></section>`;
  }
  if (session.targetConfigRevision === null || session.targetId === null) {
    return `${commandTimeline}<section><h2>Manual debugger actions</h2><p>This session has no target configuration snapshot; start a new session with one before issuing a device command.</p></section>`;
  }
  const actions = [
    ["debug.identify", "Identify target", false],
    ["debug.read_registers", "Read registers", false],
    ["debug.halt", "Halt target (approval)", true],
    ["debug.resume", "Resume target (approval)", true],
    ["debug.reset", "Reset target (approval)", true],
  ] as const;
  const buttons = actions.map(([id, label, approval]) => `<button type="submit" data-debug-action="${id}">${label}${approval ? "" : ""}</button>`).join(" ");
  return `${commandTimeline}<section><h2>Manual debugger actions</h2><p>Every button sends one bounded action through the authenticated plugin UI session and the current execution lease. Actions marked approval require this human click; the LLM cannot use this route.</p><button type="button" id="debug-release-execution" data-execution-id="${escapeHtml(executionRef)}">Release device lease</button><form id="debug-actions" data-device-id="${escapeHtml(session.soulcloudDeviceRef)}" data-execution-id="${escapeHtml(executionRef)}" data-target-config-revision="${session.targetConfigRevision}" data-target-id="${escapeHtml(session.targetId)}">${buttons}<label for="debug-memory-address">Memory address</label><input id="debug-memory-address" inputmode="text" maxlength="18" placeholder="0x20000000"><label for="debug-memory-length">Memory length (bytes)</label><input id="debug-memory-length" type="number" min="1" max="1048576" value="16"><button type="submit" data-debug-action="debug.read_memory">Read memory</button><label for="debug-start-mode">Start mode</label><select id="debug-start-mode"><option value="automatic">Automatic</option><option value="assisted">Assisted</option></select><button type="submit" data-debug-action="debug.start">Start target (approval)</button><p id="debug-action-status" role="status" aria-live="polite"></p></form></section>`;
}

function configForm(input: { installationId: string; yaml: string; cases: DebugCaseRecord[]; sessions: DebugSessionRecord[]; selectedSession: DebugSessionRecord | null; observations: DebugObservationRecord[]; targetConfigs: TargetConfigSummary[]; artifacts: DebugArtifactRecord[]; reports: DebugReportRecord[]; error?: string }): string {
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
  const sessionError = input.selectedSession ? latestSessionError(input.observations) : null;
  const errorView = input.selectedSession?.state === "failed"
    ? `<section role="alert"><h2>Debugger error</h2><p>${escapeHtml(sessionError ?? "The debugger session failed without a diagnostic message.")}</p></section>`
    : sessionError
      ? `<section role="alert"><h2>Latest debugger error</h2><p>${escapeHtml(sessionError)}</p></section>`
      : "";
  const targetConfigs = input.targetConfigs.length === 0
    ? "<p>No target configuration revisions yet.</p>"
    : `<ul>${input.targetConfigs.map((item) => `<li><strong>Revision ${item.revision}</strong> — ${item.targetCount} target(s) — <code>${escapeHtml(item.sha256)}</code> — created ${escapeHtml(item.createdAt)}</li>`).join("")}</ul>`;
  const artifacts = input.artifacts.length === 0
    ? "<p>No ELF or firmware artifacts yet.</p>"
    : `<ul>${input.artifacts.map((item) => `<li><strong>${escapeHtml(item.kind)}</strong> — ${escapeHtml(item.filename)} — ${item.size} bytes — <code>${escapeHtml(item.id)}</code> — SHA-256 <code>${escapeHtml(item.sha256)}</code> — ${observationData(item.metadata)}</li>`).join("")}</ul>`;
  const artifactCases = `<option value="">No case association</option>${input.cases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  const sessionCases = `<option value="">Select a case</option>${input.cases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  const sessionTargets = `<option value="">No target snapshot</option>${input.targetConfigs.map((item) => `<option value="${escapeHtml(item.configId)}" data-revision="${item.revision}">Revision ${item.revision} (${item.targetCount} target(s))</option>`).join("")}`;
  const sessionArtifacts = `<option value="">No artifact</option>${input.artifacts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.kind)} — ${escapeHtml(item.filename)}</option>`).join("")}`;
  const sessionForm = `<section><h2>Start debugger session</h2><p>This creates one human-scoped device lease; it does not send a debugger command.</p><form id="debug-session-create"><label for="debug-session-device">Soulcloud Device ID</label><br><input id="debug-session-device" maxlength="36" required><br><label for="debug-session-case">Case</label><br><select id="debug-session-case" required>${sessionCases}</select><br><label for="debug-session-target-config">Target configuration (optional)</label><br><select id="debug-session-target-config">${sessionTargets}</select><br><label for="debug-session-target-id">Target ID</label><br><input id="debug-session-target-id" maxlength="64"><br><label for="debug-session-artifact">Artifact (optional)</label><br><select id="debug-session-artifact">${sessionArtifacts}</select><br><button type="submit">Start debugger session</button><p id="debug-session-status" role="status" aria-live="polite"></p></form></section>`;
  const reports = input.reports.length === 0
    ? "<p>No report drafts yet.</p>"
    : `<ul>${input.reports.map((item) => `<li><strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.state)} — revision ${item.currentRevision} — case <code>${escapeHtml(item.caseId)}</code><form method="post"><input type="hidden" name="intent" value="finalize_report"><input type="hidden" name="reportId" value="${escapeHtml(item.id)}"><button type="submit"${item.state === "final" ? " disabled" : ""}>Finalize report</button></form></li>`).join("")}</ul>`;
  const reportCases = `<option value="">Select a case</option>${input.cases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  const reportOptions = `<option value="">Select a draft report</option>${input.reports.filter((item) => item.state === "draft").map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}`;
  const reportForm = `<section><h2>Reports</h2>${reports}<form method="post"><input type="hidden" name="intent" value="create_report"><label for="report-case">Case</label><br><select id="report-case" name="caseId" required>${reportCases}</select><br><label for="report-title">Report title</label><br><input id="report-title" name="reportTitle" maxlength="256" required><br><label for="report-content">Initial report content (max 64 KiB)</label><br><textarea id="report-content" name="reportContent" rows="12" cols="100" maxlength="65536"></textarea><br><button type="submit">Create report draft</button></form><form method="post"><input type="hidden" name="intent" value="append_report"><label for="report-revision">Draft report</label><br><select id="report-revision" name="reportId" required>${reportOptions}</select><br><label for="report-revision-content">New revision (max 64 KiB)</label><br><textarea id="report-revision-content" name="reportContent" rows="12" cols="100" maxlength="65536" required></textarea><br><button type="submit">Save report revision</button></form></section>`;
  const error = input.error === "invalid_target_config" ? "<p role=\"alert\">Target configuration is invalid. Review the YAML schema and try again.</p>" : "";
  return `<main><h1>SoulInjector debugger</h1>${error}${errorView}<section><h2>Cases</h2>${cases}<form method="post"><input type="hidden" name="intent" value="create_case"><label for="case-title">New case title</label><br><input id="case-title" name="title" maxlength="256" required><br><label for="target-unit-ref">Target unit reference</label><br><input id="target-unit-ref" name="targetUnitRef" maxlength="256"><br><button type="submit">Create case</button></form></section>${sessionForm}<section><h2>Sessions</h2>${sessions}</section><section><h2>Session timeline</h2>${timeline}</section>${debuggerActionControls({ selectedSession: input.selectedSession })}<section><h2>Artifacts</h2>${artifacts}<form id="artifact-upload" method="post" action="/plugins/${encodeURIComponent(input.installationId)}/debugger/artifacts"><label for="artifact-kind">Artifact type</label><br><select id="artifact-kind"><option value="elf">ELF</option><option value="firmware">Firmware</option></select><br><label for="artifact-case">Debugger case</label><br><select id="artifact-case">${artifactCases}</select><br><label for="artifact-file">Artifact file (max 64 MiB)</label><br><input id="artifact-file" type="file" accept=".elf,.bin,.img,application/octet-stream,application/x-elf" required><br><button type="submit">Upload artifact</button><p id="artifact-upload-status" role="status" aria-live="polite"></p></form></section>${reportForm}<section><h2>Target configuration</h2><p>Configure the target architecture, chip and required debugger primitives.</p><h3>Saved revisions</h3>${targetConfigs}<form method="post"><input type="hidden" name="intent" value="save_target"><label for="yaml-file">Load YAML file (最大 64 KiB)</label><br><input id="yaml-file" type="file" accept=".yaml,.yml,text/yaml,text/plain"><br><label for="yaml">Target YAML</label><br><textarea id="yaml" name="yaml" rows="24" cols="100" maxlength="65536" required>${escapeHtml(input.yaml)}</textarea><br><button type="submit">Save target configuration</button></form></section><script type="module" src="/plugins/${encodeURIComponent(input.installationId)}/assets${CLIENT_BUNDLE_PATH}" defer></script></main>`;
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
          let sessionStateUpdated = false;
          let updatedSession: DebugSessionRecord | null = null;
          if (repository.updateDebugSessionState) {
            const state = sessionStateForDeviceState(parsed.data.state);
            if (state) {
              try {
                updatedSession = await repository.updateDebugSessionState({ installationId: context.installation.id, projectId: context.installation.projectId, sessionId: parsed.data.sessionId, soulcloudDeviceRef: context.device.id, state });
                sessionStateUpdated = true;
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
          const executionState = executionStateForDeviceState(parsed.data.state);
          if (sessionAvailable && sessionStateUpdated && executionState && context.execution) {
            // The manager routes events by installation/device. A delayed
            // terminal event from an older session must not complete a newer
            // execution that happens to own the same device.
            const execution = updatedSession?.executionRef ? await context.execution.get() : null;
            if (execution && updatedSession && execution.id === updatedSession.executionRef) await context.execution.complete(executionState);
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
    readArtifactChunk: async (input) => {
      if (!repository.readArtifactChunk) throw new Error("artifact read is not available");
      const chunk = await repository.readArtifactChunk(input.artifactId, input.installationId, input.projectId, input.offset, input.length);
      if (!chunk) throw new Error("artifact not found");
      return chunk;
    },
    render: {
      debugger: async (input) => {
        const [saved, cases, sessions, targetConfigs, artifacts, reports] = await Promise.all([
          repository.getLatestTargetConfig(input.installationId),
          repository.listDebugCases ? repository.listDebugCases(input.projectId, 64) : Promise.resolve([] as DebugCaseRecord[]),
          repository.listDebugSessions ? repository.listDebugSessions(input.installationId, input.projectId, 64) : Promise.resolve([] as DebugSessionRecord[]),
          repository.listTargetConfigs ? repository.listTargetConfigs(input.installationId, input.projectId) : Promise.resolve([] as TargetConfigSummary[]),
          repository.listArtifacts ? repository.listArtifacts(input.installationId, input.projectId) : Promise.resolve([] as DebugArtifactRecord[]),
          repository.listDebugReports ? repository.listDebugReports(input.projectId, 64) : Promise.resolve([] as DebugReportRecord[]),
        ]);
        const selectedId = typeof input.params.session_id === "string" && isUuid(input.params.session_id) ? input.params.session_id : null;
        const selectedSession = selectedId && repository.getDebugSession
          ? await repository.getDebugSession(selectedId, input.installationId, input.projectId)
          : null;
        const observations = selectedSession && repository.listDebugObservations
          ? await repository.listDebugObservations(selectedSession.id, input.installationId, input.projectId, MAX_TIMELINE_OBSERVATIONS)
          : [];
        const error = typeof input.params.error === "string" ? input.params.error : undefined;
        return { html: configForm({ installationId: input.installationId, yaml: saved?.yaml ?? "version: 1\ntargets:\n  - id: example\n    displayName: Example target\n    architecture: cortex-m\n    chip: replace-me\n    transport: swd\n    requiredPrimitives:\n      - identify\n", cases, sessions, selectedSession, observations, targetConfigs, artifacts, reports, error }), title: "SoulInjector debugger", cache: "no-store" };
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
        } else if (intent === "create_report") {
          if (!repository.createDebugReport) throw new Error("debug report persistence is not available");
          const caseId = stringValue(action, "caseId");
          const reportTitle = stringValue(action, "reportTitle");
          const reportContent = typeof action === "object" && action !== null && !Array.isArray(action) && typeof (action as Record<string, unknown>).reportContent === "string"
            ? (action as Record<string, unknown>).reportContent as string
            : "";
          await repository.createDebugReport({ projectId: input.projectId, caseId, title: reportTitle, content: reportContent, createdBy: input.user.id });
        } else if (intent === "append_report") {
          if (!repository.appendDebugReportRevision) throw new Error("debug report persistence is not available");
          await repository.appendDebugReportRevision({ projectId: input.projectId, reportId: stringValue(action, "reportId"), content: stringValue(action, "reportContent"), createdBy: input.user.id });
        } else if (intent === "finalize_report") {
          if (!repository.finalizeDebugReport) throw new Error("debug report persistence is not available");
          await repository.finalizeDebugReport(stringValue(action, "reportId"), input.projectId);
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
