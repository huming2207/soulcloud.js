// Debug repair cases owned by a project.

import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { asCaseRecord, boundedText, schema, type CreateDebugCaseInput, type DebugCaseRecord, type DebugCaseState } from "./shared";

export class CaseStore {
  constructor(readonly pool: Pool) {}

  async createDebugCase(input: CreateDebugCaseInput): Promise<DebugCaseRecord> {
    const title = boundedText(input.title, "case title", 256);
    const targetUnitRef = input.targetUnitRef === null || input.targetUnitRef === undefined
      ? null
      : boundedText(input.targetUnitRef, "target unit reference", 256);
    const result = await this.pool.query<QueryResultRow>(
      `INSERT INTO ${schema}.debug_cases (id, project_id, target_unit_ref, title, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), input.projectId, targetUnitRef, title, input.createdBy],
    );
    return asCaseRecord(result.rows[0]!);
  }

  async getDebugCase(id: string, projectId: string): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }

  async listDebugCases(projectId: string, limit = 64): Promise<DebugCaseRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("case limit must be between 1 and 256");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.debug_cases
       WHERE project_id = $1
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(asCaseRecord);
  }

  async setDebugCaseState(id: string, projectId: string, state: DebugCaseState): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_cases
       SET state = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [id, projectId, state],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }

  async assignDebugCase(id: string, projectId: string, assignedTo: string | null): Promise<DebugCaseRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `UPDATE ${schema}.debug_cases
       SET assigned_to = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [id, projectId, assignedTo],
    );
    return result.rows[0] ? asCaseRecord(result.rows[0]) : null;
  }
}
