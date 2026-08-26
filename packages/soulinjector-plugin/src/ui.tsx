import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { debugLogSchema, debugStatusSchema } from "./device-protocol";
import type { DebugArtifactRecord, DebugCaseRecord, DebugObservationRecord, DebugReportRecord, DebugSessionRecord, TargetConfigSummary } from "./repository";

const MAX_OBSERVATION_DATA_CHARS = 2_048;

/**
 * The SSR page is rendered with React but several dynamic strings must stay
 * entity-escaped exactly like the previous hand-written template output
 * (React escapes & < > in text nodes but never quotes). observationData()
 * produces pre-escaped HTML for JSON payloads that commonly contain quotes,
 * so those spots are injected with dangerouslySetInnerHTML while everything
 * else flows through normal React children.
 */
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

/** Latest error message extracted from bounded session observations. */
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

export interface DebuggerPageProps {
  installationId: string;
  yaml: string;
  cases: DebugCaseRecord[];
  sessions: DebugSessionRecord[];
  selectedSession: DebugSessionRecord | null;
  observations: DebugObservationRecord[];
  targetConfigs: TargetConfigSummary[];
  artifacts: DebugArtifactRecord[];
  reports: DebugReportRecord[];
  error?: string;
  clientBundlePath: string;
}

function CasesSection({ cases }: { cases: DebugCaseRecord[] }) {
  return (
    <section>
      <h2>Cases</h2>
      {cases.length === 0 ? (
        <p>No debugger cases yet.</p>
      ) : (
        <ul>
          {cases.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              {" — "}
              {item.state}
              {item.targetUnitRef ? [" — ", item.targetUnitRef] : null}
            </li>
          ))}
        </ul>
      )}
      <form method="post">
        <input type="hidden" name="intent" value="create_case" />
        <label htmlFor="case-title">New case title</label>
        <br />
        <input id="case-title" name="title" maxLength={256} required />
        <br />
        <label htmlFor="target-unit-ref">Target unit reference</label>
        <br />
        <input id="target-unit-ref" name="targetUnitRef" maxLength={256} />
        <br />
        <button type="submit">Create case</button>
      </form>
    </section>
  );
}

function StartSessionSection({ cases, targetConfigs, artifacts }: Pick<DebuggerPageProps, "cases" | "targetConfigs" | "artifacts">) {
  return (
    <section>
      <h2>Start debugger session</h2>
      <p>This creates one human-scoped device lease; it does not send a debugger command.</p>
      <form id="debug-session-create">
        <label htmlFor="debug-session-device">Soulcloud Device ID</label>
        <br />
        <input id="debug-session-device" maxLength={36} required />
        <br />
        <label htmlFor="debug-session-case">Case</label>
        <br />
        <select id="debug-session-case" required>
          <option value="">Select a case</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <br />
        <label htmlFor="debug-session-target-config">Target configuration (optional)</label>
        <br />
        <select id="debug-session-target-config">
          <option value="">No target snapshot</option>
          {targetConfigs.map((item) => (
            <option key={item.configId} value={item.configId} data-revision={item.revision}>
              Revision {item.revision} ({item.targetCount} target(s))
            </option>
          ))}
        </select>
        <br />
        <label htmlFor="debug-session-target-id">Target ID</label>
        <br />
        <input id="debug-session-target-id" maxLength={64} />
        <br />
        <label htmlFor="debug-session-artifact">Artifact (optional)</label>
        <br />
        <select id="debug-session-artifact">
          <option value="">No artifact</option>
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>{item.kind} — {item.filename}</option>
          ))}
        </select>
        <br />
        <button type="submit">Start debugger session</button>
        <p id="debug-session-status" role="status" aria-live="polite" />
      </form>
    </section>
  );
}

function SessionsSection({ sessions }: { sessions: DebugSessionRecord[] }) {
  return (
    <section>
      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p>No debugger sessions yet.</p>
      ) : (
        <ul>
          {sessions.map((item) => (
            <li key={item.id}>
              <a href={`?session_id=${encodeURIComponent(item.id)}`}><code>{item.id}</code></a>
              {" — "}
              {item.state}
              {" — device "}
              <code>{item.soulcloudDeviceRef}</code>
              {" — started "}
              {item.startedAt}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TimelineSection({ selectedSession, observations }: Pick<DebuggerPageProps, "selectedSession" | "observations">) {
  return (
    <section>
      <h2>Session timeline</h2>
      {!selectedSession ? (
        <p>Select a debugger session to view its timeline.</p>
      ) : observations.length === 0 ? (
        <p>No observations recorded for session <code>{selectedSession.id}</code>.</p>
      ) : (
        <ol>
          {observations.map((item) => (
            <li key={item.id}>
              <time dateTime={item.createdAt}>{item.createdAt}</time>
              {" — "}
              <strong>{item.source}:{item.kind}</strong>
              {/* Pre-escaped structured payload; may contain &quot; entities. */}
              <pre dangerouslySetInnerHTML={{ __html: observationData(item.structuredData) }} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const ACTION_BUTTONS = [
  ["debug.identify", "Identify target"],
  ["debug.read_registers", "Read registers"],
  ["debug.halt", "Halt target (approval)"],
  ["debug.resume", "Resume target (approval)"],
  ["debug.reset", "Reset target (approval)"],
] as const;

function ActionControls({ selectedSession }: { selectedSession: DebugSessionRecord | null }) {
  const session = selectedSession;
  if (!session) {
    return (
      <section>
        <h2>Manual debugger actions</h2>
        <p>Select a session before issuing a device command.</p>
      </section>
    );
  }
  const commandTimeline = session.executionRef ? (
    <section id="debug-command-timeline" data-execution-id={session.executionRef}>
      <h2>Command timeline</h2>
      <p>Loading command status…</p>
    </section>
  ) : null;
  if (session.state !== "active") {
    return (
      <>
        {commandTimeline}
        <section>
          <h2>Manual debugger actions</h2>
          <p>Session is {session.state}; device actions are disabled.</p>
        </section>
      </>
    );
  }
  const executionRef = session.executionRef;
  if (executionRef === null) {
    return (
      <>
        {commandTimeline}
        <section>
          <h2>Manual debugger actions</h2>
          <p>This session has no active execution lease; device actions are disabled.</p>
        </section>
      </>
    );
  }
  if (session.targetConfigRevision === null || session.targetId === null) {
    return (
      <>
        {commandTimeline}
        <section>
          <h2>Manual debugger actions</h2>
          <p>This session has no target configuration snapshot; start a new session with one before issuing a device command.</p>
        </section>
      </>
    );
  }
  return (
    <>
      {commandTimeline}
      <section>
        <h2>Manual debugger actions</h2>
        <p>
          Every button sends one bounded action through the authenticated plugin UI session and the current execution lease.
          Actions marked approval require this human click; the LLM cannot use this route.
        </p>
        <button type="button" id="debug-release-execution" data-execution-id={executionRef}>Release device lease</button>
        <form
          id="debug-actions"
          data-device-id={session.soulcloudDeviceRef}
          data-execution-id={executionRef}
          data-target-config-revision={session.targetConfigRevision}
          data-target-id={session.targetId}
        >
          {ACTION_BUTTONS.map(([id, label]) => (
            <Fragment key={id}>
              <button type="submit" data-debug-action={id}>{label}</button>
              {" "}
            </Fragment>
          ))}
          <label htmlFor="debug-memory-address">Memory address</label>
          <input id="debug-memory-address" inputMode="text" maxLength={18} placeholder="0x20000000" />
          <label htmlFor="debug-memory-length">Memory length (bytes)</label>
          <input id="debug-memory-length" type="number" min={1} max={1_048_576} defaultValue={16} />
          <button type="submit" data-debug-action="debug.read_memory">Read memory</button>
          <label htmlFor="debug-start-mode">Start mode</label>
          <select id="debug-start-mode">
            <option value="automatic">Automatic</option>
            <option value="assisted">Assisted</option>
          </select>
          <button type="submit" data-debug-action="debug.start">Start target (approval)</button>
          <p id="debug-action-status" role="status" aria-live="polite" />
        </form>
      </section>
    </>
  );
}

function ArtifactsSection({ installationId, cases, artifacts }: Pick<DebuggerPageProps, "installationId" | "cases" | "artifacts">) {
  return (
    <section>
      <h2>Artifacts</h2>
      {artifacts.length === 0 ? (
        <p>No ELF or firmware artifacts yet.</p>
      ) : (
        <ul>
          {artifacts.map((item) => (
            <li key={item.id}>
              <strong>{item.kind}</strong>
              {" — "}
              {item.filename}
              {" — "}
              {item.size} bytes
              {" — "}
              <code>{item.id}</code>
              {" — SHA-256 "}
              <code>{item.sha256}</code>
              {" — "}
              {/* Pre-escaped metadata JSON; may contain &quot; entities. */}
              <span dangerouslySetInnerHTML={{ __html: observationData(item.metadata) }} />
            </li>
          ))}
        </ul>
      )}
      <form id="artifact-upload" method="post" action={`/plugins/${encodeURIComponent(installationId)}/debugger/artifacts`}>
        <label htmlFor="artifact-kind">Artifact type</label>
        <br />
        <select id="artifact-kind">
          <option value="elf">ELF</option>
          <option value="firmware">Firmware</option>
        </select>
        <br />
        <label htmlFor="artifact-case">Debugger case</label>
        <br />
        <select id="artifact-case">
          <option value="">No case association</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <br />
        <label htmlFor="artifact-file">Artifact file (max 64 MiB)</label>
        <br />
        <input id="artifact-file" type="file" accept=".elf,.bin,.img,application/octet-stream,application/x-elf" required />
        <br />
        <button type="submit">Upload artifact</button>
        <p id="artifact-upload-status" role="status" aria-live="polite" />
      </form>
    </section>
  );
}

function ReportsSection({ cases, reports }: Pick<DebuggerPageProps, "cases" | "reports">) {
  return (
    <section>
      <h2>Reports</h2>
      {reports.length === 0 ? (
        <p>No report drafts yet.</p>
      ) : (
        <ul>
          {reports.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              {" — "}
              {item.state}
              {" — revision "}
              {item.currentRevision}
              {" — case "}
              <code>{item.caseId}</code>
              <form method="post">
                <input type="hidden" name="intent" value="finalize_report" />
                <input type="hidden" name="reportId" value={item.id} />
                <button type="submit" disabled={item.state === "final" ? true : undefined}>Finalize report</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form method="post">
        <input type="hidden" name="intent" value="create_report" />
        <label htmlFor="report-case">Case</label>
        <br />
        <select id="report-case" name="caseId" required>
          <option value="">Select a case</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <br />
        <label htmlFor="report-title">Report title</label>
        <br />
        <input id="report-title" name="reportTitle" maxLength={256} required />
        <br />
        <label htmlFor="report-content">Initial report content (max 64 KiB)</label>
        <br />
        <textarea id="report-content" name="reportContent" rows={12} cols={100} maxLength={65536} />
        <br />
        <button type="submit">Create report draft</button>
      </form>
      <form method="post">
        <input type="hidden" name="intent" value="append_report" />
        <label htmlFor="report-revision">Draft report</label>
        <br />
        <select id="report-revision" name="reportId" required>
          <option value="">Select a draft report</option>
          {reports.filter((item) => item.state === "draft").map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <br />
        <label htmlFor="report-revision-content">New revision (max 64 KiB)</label>
        <br />
        <textarea id="report-revision-content" name="reportContent" rows={12} cols={100} maxLength={65536} required />
        <br />
        <button type="submit">Save report revision</button>
      </form>
    </section>
  );
}

function TargetConfigSection({ yaml, targetConfigs }: Pick<DebuggerPageProps, "yaml" | "targetConfigs">) {
  return (
    <section>
      <h2>Target configuration</h2>
      <p>Configure the target architecture, chip and required debugger primitives.</p>
      <h3>Saved revisions</h3>
      {targetConfigs.length === 0 ? (
        <p>No target configuration revisions yet.</p>
      ) : (
        <ul>
          {targetConfigs.map((item) => (
            <li key={item.configId}>
              <strong>Revision {item.revision}</strong>
              {" — "}
              {item.targetCount} target(s)
              {" — "}
              <code>{item.sha256}</code>
              {" — created "}
              {item.createdAt}
            </li>
          ))}
        </ul>
      )}
      <form method="post">
        <input type="hidden" name="intent" value="save_target" />
        <label htmlFor="yaml-file">Load YAML file (max 64 KiB)</label>
        <br />
        <input id="yaml-file" type="file" accept=".yaml,.yml,text/yaml,text/plain" />
        <br />
        <p id="yaml-file-status" role="status" aria-live="polite" />
        <label htmlFor="yaml">Target YAML</label>
        <br />
        <textarea id="yaml" name="yaml" rows={24} cols={100} maxLength={65536} required defaultValue={yaml} />
        <br />
        <button type="submit">Save target configuration</button>
      </form>
    </section>
  );
}

function ErrorBanner({ error }: { error?: string }) {
  if (error !== "invalid_target_config") return null;
  return <p role="alert">Target configuration is invalid. Review the YAML schema and try again.</p>;
}

function SessionErrorAlert({ selectedSession, observations }: Pick<DebuggerPageProps, "selectedSession" | "observations">) {
  const sessionError = selectedSession ? latestSessionError(observations) : null;
  if (selectedSession?.state === "failed") {
    return (
      <section role="alert">
        <h2>Debugger error</h2>
        <p>{sessionError ?? "The debugger session failed without a diagnostic message."}</p>
      </section>
    );
  }
  if (sessionError) {
    return (
      <section role="alert">
        <h2>Latest debugger error</h2>
        <p>{sessionError}</p>
      </section>
    );
  }
  return null;
}

export function DebuggerPage(props: DebuggerPageProps) {
  return (
    <main>
      <h1>SoulInjector debugger</h1>
      <ErrorBanner error={props.error} />
      <SessionErrorAlert selectedSession={props.selectedSession} observations={props.observations} />
      <CasesSection cases={props.cases} />
      <StartSessionSection cases={props.cases} targetConfigs={props.targetConfigs} artifacts={props.artifacts} />
      <SessionsSection sessions={props.sessions} />
      <TimelineSection selectedSession={props.selectedSession} observations={props.observations} />
      <ActionControls selectedSession={props.selectedSession} />
      <ArtifactsSection installationId={props.installationId} cases={props.cases} artifacts={props.artifacts} />
      <ReportsSection cases={props.cases} reports={props.reports} />
      <TargetConfigSection yaml={props.yaml} targetConfigs={props.targetConfigs} />
      <script type="module" src={`/plugins/${encodeURIComponent(props.installationId)}/assets${props.clientBundlePath}`} defer />
    </main>
  );
}

/** Render the debugger page as an HTML fragment for ui.render. */
export function renderDebuggerPage(props: DebuggerPageProps): string {
  return renderToStaticMarkup(<DebuggerPage {...props} />);
}
