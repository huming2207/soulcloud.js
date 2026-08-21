-- Append-only audit trail for high-risk operations (§3): device profile
-- binding changes, installation lifecycle and action invocations. Rows are
-- written in the same transaction as the operation they describe.

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "subject_type" VARCHAR(64) NOT NULL,
    "subject_id" VARCHAR(255) NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_project_created_idx" ON "audit_events"("project_id", "created_at" DESC);
CREATE INDEX "audit_events_subject_idx" ON "audit_events"("subject_type", "subject_id", "created_at" DESC);

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_action_not_blank"
        CHECK (btrim(action) <> ''),
    ADD CONSTRAINT "audit_events_subject_not_blank"
        CHECK (btrim(subject_type) <> '' AND btrim(subject_id) <> '');
