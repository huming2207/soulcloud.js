// Versioned debug reports: append-only revisions with draft/final states.

import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  asReportRecord,
  asReportRevisionRecord,
  asReportState,
  boundedText,
  jsonValue,
  schema,
  sha256Text,
  type AppendDebugReportRevisionInput,
  type CreateDebugReportInput,
  type DebugReportRecord,
  type DebugReportRevisionRecord,
} from "./shared";

export class ReportStore {
  constructor(readonly pool: Pool) {}

  async listDebugReports(projectId: string, limit = 64): Promise<DebugReportRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("report limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT r.* FROM ${schema}.debug_reports r
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE c.project_id = $1
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(asReportRecord);
  }

  async createDebugReport(input: CreateDebugReportInput): Promise<DebugReportRecord> {
    const title = boundedText(input.title, "report title", 256);
    const content = input.content ?? "";
    boundedText(content || "empty", "report content", 4 * 1024 * 1024);
    const metadata = jsonValue(input.metadata ?? null, "report metadata", 256 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2 FOR UPDATE`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("debug case is not available to this project");
      const reportId = randomUUID();
      const reportResult = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_reports (id, case_id, title, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [reportId, input.caseId, title, input.createdBy],
      );
      if (content.length > 0) {
        await client.query(
          `INSERT INTO ${schema}.debug_report_revisions
            (id, report_id, revision, content, content_sha256, metadata, created_by)
           VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6)`,
          [randomUUID(), reportId, content, sha256Text(content), metadata, input.createdBy],
        );
        await client.query(`UPDATE ${schema}.debug_reports SET current_revision = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reportId]);
      }
      const finalReport = await client.query<QueryResultRow>(`SELECT * FROM ${schema}.debug_reports WHERE id = $1`, [reportId]);
      await client.query("COMMIT");
      return asReportRecord(finalReport.rows[0] ?? reportResult.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendDebugReportRevision(input: AppendDebugReportRevisionInput): Promise<DebugReportRevisionRecord> {
    boundedText(input.content, "report content", 4 * 1024 * 1024);
    const metadata = jsonValue(input.metadata ?? null, "report metadata", 256 * 1024);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reportResult = await client.query<QueryResultRow>(
        `SELECT r.id, r.state, r.current_revision
         FROM ${schema}.debug_reports r
         JOIN ${schema}.debug_cases c ON c.id = r.case_id
         WHERE r.id = $1 AND c.project_id = $2 FOR UPDATE`,
        [input.reportId, input.projectId],
      );
      const report = reportResult.rows[0];
      if (!report) throw new Error("debug report is not available to this project");
      if (asReportState(report.state) !== "draft") throw new Error("final debug reports are immutable");
      const revision = Number(report.current_revision) + 1;
      const revisionResult = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.debug_report_revisions
          (id, report_id, revision, content, content_sha256, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [randomUUID(), input.reportId, revision, input.content, sha256Text(input.content), metadata, input.createdBy],
      );
      await client.query(`UPDATE ${schema}.debug_reports SET current_revision = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [input.reportId, revision]);
      await client.query("COMMIT");
      return asReportRevisionRecord(revisionResult.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_reports r
       SET state = 'final', updated_at = CURRENT_TIMESTAMP
       FROM ${schema}.debug_cases c
       WHERE r.id = $1 AND r.case_id = c.id AND c.project_id = $2 AND r.state = 'draft'
       RETURNING r.*`,
      [reportId, projectId],
    );
    return result.rows[0] ? asReportRecord(result.rows[0]) : null;
  }

  async getDebugReport(reportId: string, projectId: string): Promise<DebugReportRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT r.* FROM ${schema}.debug_reports r
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE r.id = $1 AND c.project_id = $2`,
      [reportId, projectId],
    );
    return result.rows[0] ? asReportRecord(result.rows[0]) : null;
  }

  async listDebugReportRevisions(reportId: string, projectId: string, limit = 64): Promise<DebugReportRevisionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("report revision limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT v.* FROM ${schema}.debug_report_revisions v
       JOIN ${schema}.debug_reports r ON r.id = v.report_id
       JOIN ${schema}.debug_cases c ON c.id = r.case_id
       WHERE v.report_id = $1 AND c.project_id = $2
       ORDER BY v.revision DESC
       LIMIT $3`,
      [reportId, projectId, limit],
    );
    return result.rows.map(asReportRevisionRecord);
  }
}
