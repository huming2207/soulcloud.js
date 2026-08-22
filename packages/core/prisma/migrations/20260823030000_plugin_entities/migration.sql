CREATE TABLE "plugin_entity_descriptors" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "profile_id" VARCHAR(128) NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "entity_key" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "value_type" VARCHAR(16) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "unit" VARCHAR(64),
    "enum_values" JSONB,
    "stale_after_seconds" INTEGER,
    "history" VARCHAR(16) NOT NULL DEFAULT 'none',
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plugin_entity_descriptors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plugin_entity_states" (
    "installation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "entity_key" VARCHAR(128) NOT NULL,
    "descriptor_revision" INTEGER NOT NULL,
    "value" JSONB,
    "quality" VARCHAR(16) NOT NULL,
    "source_timestamp" TIMESTAMPTZ(3),
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGINT,
    "alarm_level" VARCHAR(16),
    "alarm_code" VARCHAR(256),
    CONSTRAINT "plugin_entity_states_pkey" PRIMARY KEY ("installation_id", "device_id", "entity_key")
);

CREATE TABLE "plugin_entity_history" (
    "id" BIGSERIAL NOT NULL,
    "installation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "entity_key" VARCHAR(128) NOT NULL,
    "descriptor_revision" INTEGER NOT NULL,
    "value" JSONB,
    "quality" VARCHAR(16) NOT NULL,
    "source_timestamp" TIMESTAMPTZ(3),
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGINT,
    "alarm_level" VARCHAR(16),
    "alarm_code" VARCHAR(256),
    CONSTRAINT "plugin_entity_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_entity_descriptors_revision_unique"
    ON "plugin_entity_descriptors" ("installation_id", "profile_id", "profile_version", "entity_key", "revision");
CREATE INDEX "plugin_entity_descriptors_lookup_idx"
    ON "plugin_entity_descriptors" ("installation_id", "profile_id", "profile_version", "deprecated");
CREATE INDEX "plugin_entity_states_device_time_idx"
    ON "plugin_entity_states" ("device_id", "ingested_at");
CREATE INDEX "plugin_entity_history_device_entity_time_idx"
    ON "plugin_entity_history" ("device_id", "entity_key", "ingested_at", "id");
CREATE INDEX "plugin_entity_history_installation_time_idx"
    ON "plugin_entity_history" ("installation_id", "ingested_at");

ALTER TABLE "plugin_entity_descriptors"
    ADD CONSTRAINT "plugin_entity_descriptors_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_entity_states"
    ADD CONSTRAINT "plugin_entity_states_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_entity_states"
    ADD CONSTRAINT "plugin_entity_states_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_entity_history"
    ADD CONSTRAINT "plugin_entity_history_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_entity_history"
    ADD CONSTRAINT "plugin_entity_history_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plugin_entity_descriptors"
    ADD CONSTRAINT "plugin_entity_descriptors_revision_positive" CHECK ("revision" > 0);
ALTER TABLE "plugin_entity_descriptors"
    ADD CONSTRAINT "plugin_entity_descriptors_history_valid" CHECK ("history" IN ('none', 'changes', 'sampled', 'all'));
ALTER TABLE "plugin_entity_states"
    ADD CONSTRAINT "plugin_entity_states_quality_valid" CHECK ("quality" IN ('good', 'bad', 'uncertain', 'stale', 'unknown'));
ALTER TABLE "plugin_entity_history"
    ADD CONSTRAINT "plugin_entity_history_quality_valid" CHECK ("quality" IN ('good', 'bad', 'uncertain', 'stale', 'unknown'));
