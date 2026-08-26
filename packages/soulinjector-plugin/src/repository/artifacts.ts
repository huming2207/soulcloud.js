// Artifact storage: whole-body inserts, idempotent chunked uploads assembled
// inside PostgreSQL, bounded chunk reads and expired-upload cleanup.

import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { validateArtifact, validateArtifactMetadata } from "../artifact";
import {
  asArtifactRecord,
  asString,
  createSha256,
  optionalString,
  schema,
  UUID,
  type DebugArtifactRecord,
  type ReadArtifactChunkOutput,
  type SaveArtifactInput,
  type StoreArtifactChunkInput,
  type StoreArtifactChunkOutput,
} from "./shared";

export class ArtifactStore {
  constructor(readonly pool: Pool) {}

  async storeArtifact(input: SaveArtifactInput): Promise<DebugArtifactRecord> {
    const artifact = validateArtifact(input);
    if (input.caseId !== null && input.caseId !== undefined) {
      const caseResult = await this.pool.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`, [input.caseId, input.projectId]);
      if (!caseResult.rows[0]) throw new Error("artifact case is not available to this project");
    }
    const id = randomUUID();
    const result = await this.pool.query<QueryResultRow>(
      `INSERT INTO ${schema}.debug_artifacts
        (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, metadata, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, installation_id, project_id, kind, filename, content_type, size, sha256, metadata, created_by, created_at`,
      [id, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, artifact.metadata, Buffer.isBuffer(artifact.bytes) ? artifact.bytes : Buffer.from(artifact.bytes), input.createdBy],
    );
    return asArtifactRecord(result.rows[0]!);
  }

  async storeArtifactChunk(input: StoreArtifactChunkInput): Promise<StoreArtifactChunkOutput> {
    if (!UUID.test(input.uploadId)) throw new Error("artifact upload ID must be a UUID");
    if (input.chunk.byteLength === 0 || input.chunk.byteLength > 64 * 1024) throw new Error("artifact chunk must be 1..65536 bytes");
    if (!Number.isSafeInteger(input.totalSize) || input.totalSize <= 0 || input.totalSize > 64 * 1024 * 1024) throw new Error("invalid artifact total size");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset + input.chunk.byteLength > input.totalSize) throw new Error("invalid artifact chunk offset");
    if (!input.final && input.offset + input.chunk.byteLength === input.totalSize) throw new Error("a non-final artifact chunk must leave bytes for a final chunk");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Cleanup is handled by the bounded maintenance job. On the upload hot
      // path only remove a stale row for this ID, keeping the transaction
      // indexed and independent of the total number of expired uploads.
      await client.query(`DELETE FROM ${schema}.artifact_uploads WHERE id = $1 AND expires_at < CURRENT_TIMESTAMP`, [input.uploadId]);
      await client.query(
        `INSERT INTO ${schema}.artifact_uploads
          (id, installation_id, project_id, case_id, kind, filename, content_type, expected_size, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [input.uploadId, input.installationId, input.projectId, input.caseId ?? null, input.kind, input.filename, input.contentType, input.totalSize, input.userId],
      );
      const uploadResult = await client.query<QueryResultRow>(
        `SELECT * FROM ${schema}.artifact_uploads WHERE id = $1 FOR UPDATE`,
        [input.uploadId],
      );
      const upload = uploadResult.rows[0];
      if (!upload) throw new Error("artifact upload disappeared");
      if (asString(upload.installation_id, "installation id") !== input.installationId || asString(upload.project_id, "project id") !== input.projectId || optionalString(upload.case_id, "case id") !== (input.caseId ?? null) || asString(upload.created_by, "artifact uploader") !== input.userId || upload.kind !== input.kind || asString(upload.filename, "artifact filename") !== input.filename || asString(upload.content_type, "artifact content type") !== input.contentType || Number(upload.expected_size) !== input.totalSize) {
        throw new Error("artifact upload metadata changed");
      }
      if (input.caseId !== null && input.caseId !== undefined) {
        const caseResult = await client.query(`SELECT id FROM ${schema}.debug_cases WHERE id = $1 AND project_id = $2`, [input.caseId, input.projectId]);
        if (!caseResult.rows[0]) throw new Error("artifact case is not available to this project");
      }
      if (upload.completed_artifact_id) {
        const completed = await client.query<QueryResultRow>(
          `SELECT id, sha256 FROM ${schema}.debug_artifacts WHERE id = $1`,
          [upload.completed_artifact_id],
        );
        const artifact = completed.rows[0];
        if (!artifact) throw new Error("completed artifact disappeared");
        await client.query("COMMIT");
        return {
          uploadId: input.uploadId,
          receivedBytes: Number(upload.expected_size),
          complete: true,
          artifactId: asString(artifact.id, "artifact id"),
          sha256: asString(artifact.sha256, "artifact hash").trim(),
        };
      }
      const receivedBytes = Number(upload.received_size);
      if (input.offset !== receivedBytes) {
        const existing = await client.query<QueryResultRow>(
          `SELECT size, sha256 FROM ${schema}.artifact_upload_chunks WHERE upload_id = $1 AND offset_bytes = $2`,
          [input.uploadId, input.offset],
        );
        const digest = createSha256(input.chunk);
        if (input.offset < receivedBytes && existing.rows[0] && Number(existing.rows[0].size) === input.chunk.byteLength && asString(existing.rows[0].sha256, "artifact chunk hash").trim() === digest) {
          await client.query("COMMIT");
          return { uploadId: input.uploadId, receivedBytes, complete: false, artifactId: null, sha256: null };
        }
        throw new Error("artifact chunks must arrive in order");
      }
      const digest = createSha256(input.chunk);
      await client.query(
        `INSERT INTO ${schema}.artifact_upload_chunks (upload_id, offset_bytes, size, sha256, content) VALUES ($1, $2, $3, $4, $5)`,
        [input.uploadId, input.offset, input.chunk.byteLength, digest, Buffer.isBuffer(input.chunk) ? input.chunk : Buffer.from(input.chunk)],
      );
      const nextReceivedBytes = receivedBytes + input.chunk.byteLength;
      await client.query(`UPDATE ${schema}.artifact_uploads SET received_size = $2 WHERE id = $1`, [input.uploadId, nextReceivedBytes]);
      if (!input.final) {
        await client.query("COMMIT");
        return { uploadId: input.uploadId, receivedBytes: nextReceivedBytes, complete: false, artifactId: null, sha256: null };
      }
      if (nextReceivedBytes !== input.totalSize) throw new Error("final artifact chunk does not complete the declared size");
      // Keep the final validation bounded in the plugin process. A PostgreSQL
      // cursor fetches only a small batch of chunk bodies, while the final
      // bytea is assembled inside PostgreSQL below. This avoids retaining a
      // second 64 MiB copy in Bun for the largest supported artifact.
      const cursorName = `soulinjector_artifact_${randomUUID().replaceAll("-", "")}`;
      await client.query(
        `DECLARE ${cursorName} NO SCROLL CURSOR FOR
         SELECT offset_bytes, size, sha256, content
         FROM ${schema}.artifact_upload_chunks
         WHERE upload_id = '${input.uploadId}'::uuid
         ORDER BY offset_bytes ASC`,
      );
      const hash = createHash("sha256");
      let expectedOffset = 0;
      const header = input.kind === "elf" ? new Uint8Array(Math.min(64, input.totalSize)) : undefined;
      let headerBytes = 0;
      try {
        while (true) {
          const batch = await client.query<QueryResultRow>(`FETCH FORWARD 8 FROM ${cursorName}`);
          if (batch.rows.length === 0) break;
          for (const row of batch.rows) {
            const content = row.content;
            if (!Buffer.isBuffer(content) || Number(row.offset_bytes) !== expectedOffset || Number(row.size) !== content.byteLength) {
              throw new Error("artifact upload chunks are not contiguous");
            }
            const chunkHash = createHash("sha256").update(content).digest("hex");
            if (asString(row.sha256, "artifact chunk hash").trim().toLowerCase() !== chunkHash) {
              throw new Error("artifact upload chunk hash mismatch");
            }
            if (header && headerBytes < header.byteLength) {
              const copyLength = Math.min(content.byteLength, header.byteLength - headerBytes);
              header.set(content.subarray(0, copyLength), headerBytes);
              headerBytes += copyLength;
            }
            hash.update(content);
            expectedOffset += content.byteLength;
          }
        }
      } finally {
        await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
      }
      if (expectedOffset !== input.totalSize) throw new Error("final artifact chunks do not match the declared size");
      const artifact = validateArtifactMetadata({
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        header: header ?? new Uint8Array(),
        size: input.totalSize,
        sha256: hash.digest("hex"),
      });
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO ${schema}.debug_artifacts
          (id, installation_id, project_id, case_id, kind, filename, content_type, size, sha256, metadata, content, created_by)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                string_agg(content, ''::bytea ORDER BY offset_bytes), $11
         FROM ${schema}.artifact_upload_chunks
         WHERE upload_id = $12`,
        [artifactId, input.installationId, input.projectId, input.caseId ?? null, artifact.kind, artifact.filename, artifact.contentType, artifact.size, artifact.sha256, artifact.metadata, input.userId, input.uploadId],
      );
      await client.query(
        `UPDATE ${schema}.artifact_uploads
         SET completed_artifact_id = $2, completed_sha256 = $3
         WHERE id = $1`,
        [input.uploadId, artifactId, artifact.sha256],
      );
      await client.query(`DELETE FROM ${schema}.artifact_upload_chunks WHERE upload_id = $1`, [input.uploadId]);
      await client.query("COMMIT");
      return { uploadId: input.uploadId, receivedBytes: nextReceivedBytes, complete: true, artifactId, sha256: artifact.sha256 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readArtifactChunk(id: string, installationId: string, projectId: string, offset: number, length: number): Promise<ReadArtifactChunkOutput | null> {
    if (!UUID.test(id) || !UUID.test(installationId) || !UUID.test(projectId)) throw new RangeError("artifact scope must be UUIDs");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 64 * 1024 * 1024) throw new RangeError("artifact offset is invalid");
    if (!Number.isSafeInteger(length) || length < 1 || length > 64 * 1024) throw new RangeError("artifact chunk length is invalid");
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, size, sha256, substring(content FROM $4 FOR $5) AS chunk
       FROM ${schema}.debug_artifacts
       WHERE id = $1 AND installation_id = $2 AND project_id = $3`,
      [id, installationId, projectId, offset + 1, length],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!Buffer.isBuffer(row.chunk)) throw new Error("private plugin database returned invalid artifact chunk");
    const totalSize = Number(row.size);
    if (!Number.isSafeInteger(totalSize) || totalSize < 1 || offset >= totalSize || row.chunk.byteLength < 1 || row.chunk.byteLength > length) {
      throw new Error("private plugin database returned an invalid artifact chunk");
    }
    return {
      artifactId: asString(row.id, "artifact id"),
      offset,
      totalSize,
      sha256: asString(row.sha256, "artifact hash").trim().toLowerCase(),
      chunk: new Uint8Array(row.chunk.buffer, row.chunk.byteOffset, row.chunk.byteLength),
      final: offset + row.chunk.byteLength === totalSize,
    };
  }

  async listArtifacts(installationId: string, projectId: string): Promise<DebugArtifactRecord[]> {
    const result = await this.pool.query<QueryResultRow>(
      `SELECT id, installation_id, project_id, kind, filename, content_type, size, sha256, metadata, created_by, created_at
       FROM ${schema}.debug_artifacts
       WHERE installation_id = $1 AND project_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 64`,
      [installationId, projectId],
    );
    return result.rows.map(asArtifactRecord);
  }

  async purgeExpiredArtifactUploads(batchSize = 256): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) throw new RangeError("artifact upload cleanup batch size must be between 1 and 10000");
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT id FROM ${schema}.artifact_uploads
         WHERE expires_at < CURRENT_TIMESTAMP
         ORDER BY expires_at ASC, id ASC
         LIMIT $1
       )
       DELETE FROM ${schema}.artifact_uploads uploads
       USING expired
       WHERE uploads.id = expired.id`,
      [batchSize],
    );
    return result.rowCount ?? 0;
  }
}
