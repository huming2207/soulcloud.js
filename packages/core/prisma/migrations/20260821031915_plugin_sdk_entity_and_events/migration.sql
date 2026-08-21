-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "plugin_id" VARCHAR(255),
ADD COLUMN     "plugin_installation_id" UUID,
ADD COLUMN     "profile_configuration" JSONB,
ADD COLUMN     "profile_id" VARCHAR(255),
ADD COLUMN     "profile_version" INTEGER;

-- CreateTable
CREATE TABLE "plugin_installations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "plugin_id" VARCHAR(255) NOT NULL,
    "configured_plugin_version" VARCHAR(64) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'enabled',
    "error_detail" TEXT,
    "config_json" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "plugin_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_descriptor_revisions" (
    "id" UUID NOT NULL,
    "plugin_id" VARCHAR(255) NOT NULL,
    "profile_id" VARCHAR(255) NOT NULL,
    "entity_key" VARCHAR(255) NOT NULL,
    "revision" INTEGER NOT NULL,
    "descriptor" JSONB NOT NULL,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_descriptor_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_registry" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "plugin_id" VARCHAR(255) NOT NULL,
    "entity_key" VARCHAR(255) NOT NULL,
    "descriptor_revision_id" UUID NOT NULL,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_current_state" (
    "entity_registry_id" UUID NOT NULL,
    "value" JSONB,
    "quality" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "source_timestamp" TIMESTAMPTZ,
    "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGINT,
    "alarm_level" VARCHAR(16),
    "alarm_code" VARCHAR(64),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "entity_current_state_pkey" PRIMARY KEY ("entity_registry_id")
);

-- CreateTable
CREATE TABLE "entity_history" (
    "id" BIGSERIAL NOT NULL,
    "entity_registry_id" UUID NOT NULL,
    "descriptor_revision_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "value" JSONB,
    "quality" VARCHAR(16) NOT NULL,
    "source_timestamp" TIMESTAMPTZ,
    "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGINT,
    "alarm_level" VARCHAR(16),
    "alarm_code" VARCHAR(64),

    CONSTRAINT "entity_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_events" (
    "id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "event_kind" VARCHAR(255) NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ,
    "idempotency_key" VARCHAR(255),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "plugin_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plugin_installations_plugin_id_idx" ON "plugin_installations"("plugin_id");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_installations_project_plugin_unique" ON "plugin_installations"("project_id", "plugin_id");

-- CreateIndex
CREATE INDEX "entity_descriptor_revisions_plugin_id_profile_id_entity_key_idx" ON "entity_descriptor_revisions"("plugin_id", "profile_id", "entity_key");

-- CreateIndex
CREATE UNIQUE INDEX "entity_descriptor_revisions_identity_unique" ON "entity_descriptor_revisions"("plugin_id", "profile_id", "entity_key", "revision");

-- CreateIndex
CREATE INDEX "entity_registry_device_id_idx" ON "entity_registry"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_registry_identity_unique" ON "entity_registry"("device_id", "plugin_id", "entity_key");

-- CreateIndex
CREATE INDEX "entity_history_entity_idx" ON "entity_history"("entity_registry_id", "id");

-- CreateIndex
CREATE INDEX "entity_history_device_idx" ON "entity_history"("device_id", "id");

-- CreateIndex
CREATE INDEX "plugin_events_state_available_idx" ON "plugin_events"("state", "available_at");

-- CreateIndex
CREATE INDEX "plugin_events_installation_state_idx" ON "plugin_events"("plugin_installation_id", "state", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_events_idempotency_unique" ON "plugin_events"("idempotency_key");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugin_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_registry" ADD CONSTRAINT "entity_registry_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_registry" ADD CONSTRAINT "entity_registry_descriptor_revision_id_fkey" FOREIGN KEY ("descriptor_revision_id") REFERENCES "entity_descriptor_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_current_state" ADD CONSTRAINT "entity_current_state_entity_registry_id_fkey" FOREIGN KEY ("entity_registry_id") REFERENCES "entity_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_history" ADD CONSTRAINT "entity_history_entity_registry_id_fkey" FOREIGN KEY ("entity_registry_id") REFERENCES "entity_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_history" ADD CONSTRAINT "entity_history_descriptor_revision_id_fkey" FOREIGN KEY ("descriptor_revision_id") REFERENCES "entity_descriptor_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_events" ADD CONSTRAINT "plugin_events_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_events" ADD CONSTRAINT "plugin_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints Prisma cannot represent (repo convention: documented
-- beside the schema fields, enforced here).

ALTER TABLE "plugin_installations"
    ADD CONSTRAINT "plugin_installations_state_allowed"
        CHECK (state IN ('enabled', 'draining', 'disabled', 'error')),
    ADD CONSTRAINT "plugin_installations_plugin_id_not_blank"
        CHECK (btrim(plugin_id) <> ''),
    ADD CONSTRAINT "plugin_installations_version_not_blank"
        CHECK (btrim(configured_plugin_version) <> '');

-- The three profile columns are either all NULL (builtin soulcloud.generic)
-- or all set. plugin_id matching the installation is enforced in the
-- service layer (cross-table checks are not possible in PostgreSQL).
ALTER TABLE "devices"
    ADD CONSTRAINT "devices_plugin_profile_consistent"
        CHECK ((plugin_id IS NULL AND profile_id IS NULL AND profile_version IS NULL)
            OR (plugin_id IS NOT NULL AND profile_id IS NOT NULL AND profile_version IS NOT NULL));

ALTER TABLE "entity_descriptor_revisions"
    ADD CONSTRAINT "entity_descriptor_revisions_revision_positive"
        CHECK (revision > 0),
    ADD CONSTRAINT "entity_descriptor_revisions_ids_not_blank"
        CHECK (btrim(plugin_id) <> '' AND btrim(profile_id) <> '' AND btrim(entity_key) <> '');

ALTER TABLE "entity_registry"
    ADD CONSTRAINT "entity_registry_ids_not_blank"
        CHECK (btrim(plugin_id) <> '' AND btrim(entity_key) <> '');

ALTER TABLE "entity_current_state"
    ADD CONSTRAINT "entity_current_state_quality_allowed"
        CHECK (quality IN ('good', 'bad', 'uncertain', 'stale', 'unknown')),
    ADD CONSTRAINT "entity_current_state_alarm_level_allowed"
        CHECK (alarm_level IS NULL OR alarm_level IN ('info', 'warning', 'critical'));

ALTER TABLE "entity_history"
    ADD CONSTRAINT "entity_history_quality_allowed"
        CHECK (quality IN ('good', 'bad', 'uncertain', 'stale', 'unknown')),
    ADD CONSTRAINT "entity_history_alarm_level_allowed"
        CHECK (alarm_level IS NULL OR alarm_level IN ('info', 'warning', 'critical'));

ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_state_allowed"
        CHECK (state IN ('pending', 'leased', 'failed', 'completed', 'dead')),
    ADD CONSTRAINT "plugin_events_attempt_count_nonnegative"
        CHECK (attempt_count >= 0),
    ADD CONSTRAINT "plugin_events_schema_version_positive"
        CHECK (schema_version > 0),
    ADD CONSTRAINT "plugin_events_event_kind_not_blank"
        CHECK (btrim(event_kind) <> '');
