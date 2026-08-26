// Facade over the plugin-private database stores. The public API of the
// former single-file repository is unchanged: every method keeps its name,
// signature and SQL behavior; each domain delegates to its store class.

import { Pool } from "pg";
import { ArtifactStore } from "./artifacts";
import { CaseStore } from "./cases";
import { ReportStore } from "./reports";
import { SessionStore } from "./sessions";
import { TargetConfigStore } from "./target-configs";
import {
  MIGRATION,
  type AppendDebugObservationInput,
  type AppendDebugReportRevisionInput,
  type CreateDebugCaseInput,
  type CreateDebugReportInput,
  type CreateDebugSessionInput,
  type DebugArtifactRecord,
  type DebugCaseRecord,
  type DebugCaseState,
  type DebugObservationRecord,
  type DebugReportRecord,
  type DebugReportRevisionRecord,
  type DebugSessionRecord,
  type DebugSessionState,
  type ReadArtifactChunkOutput,
  type SaveArtifactInput,
  type SaveTargetConfigInput,
  type StoreArtifactChunkInput,
  type StoreArtifactChunkOutput,
  type TargetConfigRecord,
  type TargetConfigSummary,
  type UpdateDebugSessionStateInput,
} from "./shared";

export * from "./shared";

export class SoulInjectorRepository {
  readonly #targetConfigs: TargetConfigStore;
  readonly #artifacts: ArtifactStore;
  readonly #cases: CaseStore;
  readonly #sessions: SessionStore;
  readonly #reports: ReportStore;

  constructor(readonly pool: Pool) {
    this.#targetConfigs = new TargetConfigStore(pool);
    this.#artifacts = new ArtifactStore(pool);
    this.#cases = new CaseStore(pool);
    this.#sessions = new SessionStore(pool);
    this.#reports = new ReportStore(pool);
  }

  static fromEnv(): SoulInjectorRepository {
    const url = process.env.SOULINJECTOR_PLUGIN_DATABASE_URL;
    if (!url) throw new Error("SOULINJECTOR_PLUGIN_DATABASE_URL is required; the plugin must not use Soulcloud's core DATABASE_URL");
    const max = Number(process.env.SOULINJECTOR_PLUGIN_DB_POOL_SIZE ?? "4");
    if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error("SOULINJECTOR_PLUGIN_DB_POOL_SIZE must be between 1 and 32");
    return new SoulInjectorRepository(new Pool({ connectionString: url, max }));
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(MIGRATION);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- target configurations ---

  saveTargetConfig(input: SaveTargetConfigInput): Promise<TargetConfigRecord> {
    return this.#targetConfigs.saveTargetConfig(input);
  }

  getLatestTargetConfig(installationId: string, projectId: string): Promise<TargetConfigRecord | null> {
    return this.#targetConfigs.getLatestTargetConfig(installationId, projectId);
  }

  getTargetConfig(installationId: string, projectId: string, revision: number): Promise<TargetConfigRecord | null> {
    return this.#targetConfigs.getTargetConfig(installationId, projectId, revision);
  }

  listTargetConfigs(installationId: string, projectId: string): Promise<TargetConfigSummary[]> {
    return this.#targetConfigs.listTargetConfigs(installationId, projectId);
  }

  // --- artifacts ---

  storeArtifact(input: SaveArtifactInput): Promise<DebugArtifactRecord> {
    return this.#artifacts.storeArtifact(input);
  }

  storeArtifactChunk(input: StoreArtifactChunkInput): Promise<StoreArtifactChunkOutput> {
    return this.#artifacts.storeArtifactChunk(input);
  }

  readArtifactChunk(id: string, installationId: string, projectId: string, offset: number, length: number): Promise<ReadArtifactChunkOutput | null> {
    return this.#artifacts.readArtifactChunk(id, installationId, projectId, offset, length);
  }

  listArtifacts(installationId: string, projectId: string): Promise<DebugArtifactRecord[]> {
    return this.#artifacts.listArtifacts(installationId, projectId);
  }

  purgeExpiredArtifactUploads(batchSize = 256): Promise<number> {
    return this.#artifacts.purgeExpiredArtifactUploads(batchSize);
  }

  // --- cases ---

  createDebugCase(input: CreateDebugCaseInput): Promise<DebugCaseRecord> {
    return this.#cases.createDebugCase(input);
  }

  getDebugCase(id: string, projectId: string): Promise<DebugCaseRecord | null> {
    return this.#cases.getDebugCase(id, projectId);
  }

  listDebugCases(projectId: string, limit = 64): Promise<DebugCaseRecord[]> {
    return this.#cases.listDebugCases(projectId, limit);
  }

  setDebugCaseState(id: string, projectId: string, state: DebugCaseState): Promise<DebugCaseRecord | null> {
    return this.#cases.setDebugCaseState(id, projectId, state);
  }

  assignDebugCase(id: string, projectId: string, assignedTo: string | null): Promise<DebugCaseRecord | null> {
    return this.#cases.assignDebugCase(id, projectId, assignedTo);
  }

  // --- sessions and observations ---

  createDebugSession(input: CreateDebugSessionInput): Promise<DebugSessionRecord> {
    return this.#sessions.createDebugSession(input);
  }

  finishDebugSession(id: string, installationId: string, projectId: string, state: Exclude<DebugSessionState, "active" | "paused">): Promise<DebugSessionRecord | null> {
    return this.#sessions.finishDebugSession(id, installationId, projectId, state);
  }

  abortDebugSession(
    id: string | null,
    executionRef: string,
    installationId: string,
    projectId: string,
    soulcloudDeviceRef: string,
  ): Promise<DebugSessionRecord | null> {
    return this.#sessions.abortDebugSession(id, executionRef, installationId, projectId, soulcloudDeviceRef);
  }

  updateDebugSessionState(input: UpdateDebugSessionStateInput): Promise<DebugSessionRecord> {
    return this.#sessions.updateDebugSessionState(input);
  }

  getDebugSession(id: string, installationId: string, projectId: string): Promise<DebugSessionRecord | null> {
    return this.#sessions.getDebugSession(id, installationId, projectId);
  }

  listDebugSessions(installationId: string, projectId: string, limit = 64): Promise<DebugSessionRecord[]> {
    return this.#sessions.listDebugSessions(installationId, projectId, limit);
  }

  appendDebugObservation(input: AppendDebugObservationInput): Promise<DebugObservationRecord> {
    return this.#sessions.appendDebugObservation(input);
  }

  listDebugObservations(sessionId: string, installationId: string, projectId: string, limit = 128): Promise<DebugObservationRecord[]> {
    return this.#sessions.listDebugObservations(sessionId, installationId, projectId, limit);
  }

  // --- reports ---

  listDebugReports(projectId: string, limit = 64): Promise<DebugReportRecord[]> {
    return this.#reports.listDebugReports(projectId, limit);
  }

  createDebugReport(input: CreateDebugReportInput): Promise<DebugReportRecord> {
    return this.#reports.createDebugReport(input);
  }

  appendDebugReportRevision(input: AppendDebugReportRevisionInput): Promise<DebugReportRevisionRecord> {
    return this.#reports.appendDebugReportRevision(input);
  }

  finalizeDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    return this.#reports.finalizeDebugReport(reportId, projectId);
  }

  getDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    return this.#reports.getDebugReport(reportId, projectId);
  }

  listDebugReportRevisions(reportId: string, projectId: string, limit = 64): Promise<DebugReportRevisionRecord[]> {
    return this.#reports.listDebugReportRevisions(reportId, projectId, limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
