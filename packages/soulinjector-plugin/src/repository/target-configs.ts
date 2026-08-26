// Target configuration revisions persisted in the plugin-private database.

import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { targetConfigHash, parseTargetConfigYaml } from "../target-config";
import { asRecord, asString, schema, type SaveTargetConfigInput, type TargetConfigRecord, type TargetConfigSummary } from "./shared";

export class TargetConfigStore {
  constructor(readonly pool: Pool) {}

  async saveTargetConfig(input: SaveTargetConfigInput): Promise<TargetConfigRecord> {
    const config = parseTargetConfigYaml(input.yaml);
    const hash = await targetConfigHash(config);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${schema}.target_config_heads (installation_id, project_id, latest_revision)
         VALUES ($1, $2, 1) ON CONFLICT (installation_id) DO NOTHING`,
        [input.installationId, input.projectId],
      );
      const head = await client.query<{ latest_revision: number; project_id: string }>(
        `SELECT latest_revision, project_id FROM ${schema}.target_config_heads WHERE installation_id = $1 FOR UPDATE`,
        [input.installationId],
      );
      const row = head.rows[0];
      if (!row) throw new Error("target config head disappeared during save");
      if (row.project_id !== input.projectId) throw new Error("target config installation belongs to another project");
      const latest = await client.query<QueryResultRow>(
        `SELECT * FROM ${schema}.target_config_revisions WHERE installation_id = $1 ORDER BY revision DESC LIMIT 1`,
        [input.installationId],
      );
      if (latest.rows[0] && asString(latest.rows[0].sha256, "target config hash").trim() === hash) {
        await client.query("COMMIT");
        return asRecord(latest.rows[0]);
      }
      const revision = Number(row.latest_revision);
      const id = randomUUID();
      const inserted = await client.query<QueryResultRow>(
        `INSERT INTO ${schema}.target_config_revisions
          (id, installation_id, project_id, revision, yaml_content, config_json, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [id, input.installationId, input.projectId, revision, input.yaml, JSON.stringify(config), hash, input.createdBy],
      );
      await client.query(
        `UPDATE ${schema}.target_config_heads SET latest_revision = $2, updated_at = CURRENT_TIMESTAMP WHERE installation_id = $1`,
        [input.installationId, revision + 1],
      );
      await client.query("COMMIT");
      return asRecord(inserted.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLatestTargetConfig(installationId: string, projectId: string): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [installationId, projectId],
    );
    return result.rows[0] ? asRecord(result.rows[0]) : null;
  }

  async getTargetConfig(installationId: string, projectId: string, revision: number): Promise<TargetConfigRecord | null> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT * FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2 AND revision = $3`,
      [installationId, projectId, revision],
    );
    return result.rows[0] ? asRecord(result.rows[0]) : null;
  }

  async listTargetConfigs(installationId: string, projectId: string): Promise<TargetConfigSummary[]> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, revision, sha256, jsonb_array_length(config_json->'targets') AS target_count, created_at
       FROM ${schema}.target_config_revisions
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY revision DESC
       LIMIT 64`,
      [installationId, projectId],
    );
    return result.rows.map((row) => ({
      configId: asString(row.id, "target config id"),
      revision: Number(row.revision),
      sha256: asString(row.sha256, "target config hash").trim(),
      targetCount: Number(row.target_count),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }
}
