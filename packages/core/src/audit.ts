/**
 * Append-only audit trail for high-risk operations (§3: device profile
 * changes need "独立权限、审计记录"; stage 3 records the audit half — a
 * dedicated permission/role system is deferred until one exists).
 *
 * Rows are written in the SAME transaction as the operation they describe,
 * so an operation and its audit record are atomic. The table is never
 * updated or deleted by application code.
 */

import { randomUUID } from "node:crypto";
import type { DbExecutor } from "./db";

export type AuditAction =
  | "device.profile.bind"
  | "device.profile.unbind"
  | "installation.create"
  | "installation.update"
  | "installation.migrate"
  | "installation.disable"
  | "installation.enable"
  | "device.action.invoke";

/**
 * Records one audit event. `detail` must be JSON-serializable; keep
 * secrets (credentials, tokens) out of it.
 */
export async function recordAuditEvent(
  prisma: DbExecutor,
  params: {
    projectId: string;
    /** Null for service actors (stage 4+ station operators). */
    actorUserId: string | null;
    action: AuditAction;
    subjectType: string;
    subjectId: string;
    detail?: unknown;
  },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO audit_events
      (id, project_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
    VALUES (${randomUUID()}, ${params.projectId}, ${params.actorUserId},
            ${params.action}, ${params.subjectType}, ${params.subjectId},
            ${JSON.stringify(params.detail ?? null)}::jsonb, now())
  `;
}
