// Debug sessions and their device-reported observation timeline.

import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  asObservationRecord,
  asSessionRecord,
  asSessionState,
  boundedText,
  DebugSessionConflictError,
  DebugSessionNotAvailableError,
  jsonValue,
  schema,
  UUID,
  type AppendDebugObservationInput,
  type CreateDebugSessionInput,
  type DebugObservationRecord,
  type DebugSessionRecord,
  type DebugSessionState,
  type UpdateDebugSessionStateInput,
} from "./shared";

export class SessionStore {
  constructor(readonly pool: Pool) {}

  async createDebugSession(input: CreateDebugSessionInput): Promise<DebugSessionRecord> {
    const pluginVersion = boundedText(input.pluginVersion, "plugin version", 128);
    const deviceFirmwareVersion = input.deviceFirmwareVersion === null || input.deviceFirmwareVersion === undefined
      ? null
      : boundedText(input.deviceFirmwareVersion, "device firmware version", 256);
    if (!/^[0-9a-f]{64}$/i.test(input.manifestHash)) throw new RangeError("manifestHash must be a SHA-256 hex digest");
    if (!UUID.test(input.soulcloudDeviceRef)) throw new RangeError("Soulcloud Device reference must be a UUID");
    if (input.executionRef !== null && input.executionRef !== undefined && !UUID.test(input.executionRef)) throw new RangeError("execution reference must be a UUID");
    const targetConfigId = input.targetConfigId === null || input.targetConfigId === undefined ? null : input.targetConfigId;
    if (targetConfigId !== null && !UUID.test(targetConfigId)) throw new RangeError("target configuration id must be a UUID");
    const targetConfigRevision = input.targetConfigRevision === null || input.targetConfigRevision === undefined ? null : input.targetConfigRevision;
    if (targetConfigRevision !== null && (!Number.isSafeInteger(targetConfigRevision) || targetConfigRevision < 1)) throw new RangeError("target configuration revision must be a positive safe integer");
    const targetId = input.targetId === null || input.targetId === undefined ? null : boundedText(input.targetId, "target id", 64);
    const artifactId = input.artifactId === null || input.artifactId === undefined ? null : input.artifactId;
    if (artifactId !== null && !UUID.test(artifactId)) throw new RangeError("artifact id must be a UUID");
    if ((targetConfigId === null) !== (targetConfigRevision === null) || (targetConfigRevision === null) !== (targetId === null)) throw new RangeError("target configuration id, revision and target id must be provided together");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2 FOR UPDATE`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("debug case is not available to this project");
      if (targetConfigId !== null) {
        const targetResult = await client.query(
          `SELECT id FROM ${schema}.target_config_revisions
           WHERE id = $1 AND installation_id = $2 AND project_id = $3 AND revision = $4`,
          [targetConfigId, input.installationId, input.projectId, targetConfigRevision],
        );
        if (!targetResult.rows[0]) throw new Error("target configuration revision is not available to this installation");
      }
      if (artifactId !== null) {
        const artifactResult = await client.query(
          `SELECT id FROM ${schema}.debug_artifacts
           WHERE id = $1 AND installation_id = $2 AND project_id = $3
             AND (case_id = $4 OR case_id IS NULL)`,
          [artifactId, input.installationId, input.projectId, input.caseId],
        );
        if (!artifactResult.rows[0]) throw new Error("debug artifact is not available to this session");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_sessions
         (id, case_id, installation_id, soulcloud_device_ref, execution_ref, plugin_version, manifest_hash, device_firmware_version,
          target_config_id, target_config_revision, target_id, artifact_id, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (execution_ref) WHERE execution_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [randomUUID(), input.caseId, input.installationId, input.soulcloudDeviceRef, input.executionRef ?? null, pluginVersion, input.manifestHash.toLowerCase(), deviceFirmwareVersion, targetConfigId, targetConfigRevision, targetId, artifactId, input.startedBy],
      );
      if (!result.rows[0] && input.executionRef) {
        const existingResult = await client.query<QueryResultRow>(
          `SELECT s.* FROM ${schema}.debug_sessions s
           JOIN ${schema}.debug_cases c ON c.id = s.case_id
           WHERE s.execution_ref = $1 AND c.project_id = $2 AND s.installation_id = $3
           FOR UPDATE`,
          [input.executionRef, input.projectId, input.installationId],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error("debug session disappeared after idempotent insert");
        const sameSession = existing.case_id === input.caseId
          && existing.installation_id === input.installationId
          && existing.soulcloud_device_ref === input.soulcloudDeviceRef
          && existing.plugin_version === pluginVersion
          && String(existing.manifest_hash).trim().toLowerCase() === input.manifestHash.toLowerCase()
          && (existing.device_firmware_version ?? null) === deviceFirmwareVersion
          && (existing.target_config_id ?? null) === targetConfigId
          && (existing.target_config_revision === null || existing.target_config_revision === undefined ? null : Number(existing.target_config_revision)) === targetConfigRevision
          && (existing.target_id ?? null) === targetId
          && (existing.artifact_id ?? null) === artifactId
          && existing.started_by === input.startedBy;
        if (!sameSession) throw new DebugSessionConflictError();
        await client.query("COMMIT");
        return asSessionRecord(existing);
      }
      await client.query("COMMIT");
      return asSessionRecord(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishDebugSession(id: string, installationId: string, projectId: string, state: Exclude<DebugSessionState, "active" | "paused">): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_sessions s
       SET state = $4, ended_at = COALESCE(s.ended_at, CURRENT_TIMESTAMP)
       FROM ${schema}.debug_cases c
       WHERE s.id = $1 AND s.installation_id = $2 AND s.case_id = c.id AND c.project_id = $3
       RETURNING s.*`,
      [id, installationId, projectId, state],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  /** Mark a bootstrap-created session failed without issuing any device command. */
  async abortDebugSession(
    id: string | null,
    executionRef: string,
    installationId: string,
    projectId: string,
    soulcloudDeviceRef: string,
  ): Promise<DebugSessionRecord | null> {
    if ((id !== null && !UUID.test(id)) || !UUID.test(executionRef) || !UUID.test(soulcloudDeviceRef)) return null;
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_sessions s
       SET state = CASE WHEN s.state IN ('completed', 'failed', 'cancelled') THEN s.state ELSE 'failed' END,
           ended_at = CASE WHEN s.state IN ('completed', 'failed', 'cancelled') THEN s.ended_at ELSE COALESCE(s.ended_at, CURRENT_TIMESTAMP) END
       FROM ${schema}.debug_cases c
       WHERE ($1::uuid IS NULL OR s.id = $1::uuid) AND s.execution_ref = $2 AND s.installation_id = $3
         AND s.soulcloud_device_ref = $4 AND s.case_id = c.id AND c.project_id = $5
       RETURNING s.*`,
      [id, executionRef, installationId, soulcloudDeviceRef, projectId],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async updateDebugSessionState(input: UpdateDebugSessionStateInput): Promise<DebugSessionRecord> {
    if (!UUID.test(input.sessionId)) throw new RangeError("session id must be a UUID");
    if (!UUID.test(input.soulcloudDeviceRef)) throw new RangeError("Soulcloud Device reference must be a UUID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<QueryResultRow>(
        `SELECT s.* FROM ${schema}.debug_sessions s
         JOIN ${schema}.debug_cases c ON c.id = s.case_id
         WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3 AND s.soulcloud_device_ref = $4
         FOR UPDATE`,
        [input.sessionId, input.installationId, input.projectId, input.soulcloudDeviceRef],
      );
      const current = currentResult.rows[0];
      if (!current) throw new DebugSessionNotAvailableError();
      const currentState = asSessionState(current.state);
      if (currentState === "completed" || currentState === "failed" || currentState === "cancelled") {
        await client.query("COMMIT");
        return asSessionRecord(current);
      }
      const endedAt = input.state === "completed" || input.state === "failed" || input.state === "cancelled";
      const updatedResult = await client.query<QueryResultRow>(
        `UPDATE ${schema}.debug_sessions
         SET state = $4, ended_at = CASE WHEN $5::boolean THEN COALESCE(ended_at, CURRENT_TIMESTAMP) ELSE ended_at END
         WHERE id = $1 AND EXISTS (
           SELECT 1 FROM ${schema}.debug_cases c
           WHERE c.id = debug_sessions.case_id AND c.project_id = $2
         ) AND installation_id = $3 AND soulcloud_device_ref = $6
         RETURNING *`,
        [input.sessionId, input.projectId, input.installationId, input.state, endedAt, input.soulcloudDeviceRef],
      );
      if (!updatedResult.rows[0]) throw new Error("debug session disappeared while updating state");
      await client.query("COMMIT");
      return asSessionRecord(updatedResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDebugSession(id: string, installationId: string, projectId: string): Promise<DebugSessionRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3`,
      [id, installationId, projectId],
    );
    return result.rows[0] ? asSessionRecord(result.rows[0]) : null;
  }

  async listDebugSessions(installationId: string, projectId: string, limit = 64): Promise<DebugSessionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("session limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT s.* FROM ${schema}.debug_sessions s
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE s.installation_id = $1 AND c.project_id = $2
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT $3`,
      [installationId, projectId, limit],
    );
    return result.rows.map(asSessionRecord);
  }

  async appendDebugObservation(input: AppendDebugObservationInput): Promise<DebugObservationRecord> {
    const source = boundedText(input.source, "observation source", 64);
    const kind = boundedText(input.kind, "observation kind", 128);
    const soulcloudDeviceRef = input.soulcloudDeviceRef === null || input.soulcloudDeviceRef === undefined
      ? null
      : boundedText(input.soulcloudDeviceRef, "Soulcloud Device reference", 256);
    const eventRef = input.eventRef === null || input.eventRef === undefined ? null : boundedText(input.eventRef, "observation event reference", 128);
    const structuredData = jsonValue(input.structuredData, "observation data", 512 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        `SELECT s.id FROM ${schema}.debug_sessions s
         JOIN ${schema}.debug_cases c ON c.id = s.case_id
         WHERE s.id = $1 AND s.installation_id = $2 AND c.project_id = $3
           AND ($4::text IS NULL OR s.soulcloud_device_ref = $4)
         FOR UPDATE`,
        [input.sessionId, input.installationId, input.projectId, soulcloudDeviceRef],
      );
      if (!sessionResult.rows[0]) throw new DebugSessionNotAvailableError();
      if (input.artifactId !== null && input.artifactId !== undefined) {
        const artifactResult = await client.query(
          `SELECT id FROM ${schema}.debug_artifacts WHERE id = $1 AND installation_id = $2 AND project_id = $3`,
          [input.artifactId, input.installationId, input.projectId],
        );
        if (!artifactResult.rows[0]) throw new Error("observation artifact is not available to this project");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_observations (id, session_id, event_ref, source, kind, structured_data, artifact_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (session_id, event_ref) WHERE event_ref IS NOT NULL DO NOTHING
         RETURNING *`,
        [randomUUID(), input.sessionId, eventRef, source, kind, structuredData, input.artifactId ?? null],
      );
      if (!result.rows[0] && eventRef !== null) {
        const existing = await client.query<QueryResultRow>(
          `SELECT * FROM ${schema}.debug_observations WHERE session_id = $1 AND event_ref = $2`,
          [input.sessionId, eventRef],
        );
        if (!existing.rows[0]) throw new Error("debug observation disappeared after idempotent insert");
        await client.query("COMMIT");
        return asObservationRecord(existing.rows[0]);
      }
      await client.query("COMMIT");
      return asObservationRecord(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDebugObservations(sessionId: string, installationId: string, projectId: string, limit = 128): Promise<DebugObservationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new RangeError("observation limit must be between 1 and 512");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT o.* FROM ${schema}.debug_observations o
       JOIN ${schema}.debug_sessions s ON s.id = o.session_id
       JOIN ${schema}.debug_cases c ON c.id = s.case_id
       WHERE o.session_id = $1 AND s.installation_id = $2 AND c.project_id = $3
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $4`,
      [sessionId, installationId, projectId, limit],
    );
    return result.rows.reverse().map(asObservationRecord);
  }
}
