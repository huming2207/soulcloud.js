CREATE TABLE "plugin_installations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "plugin_id" VARCHAR(128) NOT NULL,
    "plugin_version" VARCHAR(128) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'enabled',
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plugin_device_bindings" (
    "device_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "profile_id" VARCHAR(128) NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_device_bindings_pkey" PRIMARY KEY ("device_id")
);

CREATE TABLE "plugin_events" (
    "id" UUID NOT NULL,
    "event_id" CHAR(32) NOT NULL,
    "device_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" VARCHAR(128) NOT NULL,
    "schema" INTEGER NOT NULL,
    "payload" BYTEA NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installation_id" UUID,
    "plugin_id" VARCHAR(128),
    "plugin_version" VARCHAR(128),
    "manifest_hash" CHAR(64),
    "profile_id" VARCHAR(128),
    "profile_version" INTEGER,
    "installation_config" JSONB,
    "state" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(3),
    "lease_token" VARCHAR(64),
    "finished_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_installations_project_plugin_unique"
    ON "plugin_installations" ("project_id", "plugin_id");
CREATE INDEX "plugin_installations_plugin_id_state_idx"
    ON "plugin_installations" ("plugin_id", "state");
CREATE INDEX "plugin_device_bindings_installation_id_idx"
    ON "plugin_device_bindings" ("installation_id");
CREATE UNIQUE INDEX "plugin_events_device_event_unique"
    ON "plugin_events" ("device_id", "event_id");
CREATE INDEX "plugin_events_state_available_idx"
    ON "plugin_events" ("state", "available_at");
CREATE INDEX "plugin_events_installation_state_idx"
    ON "plugin_events" ("installation_id", "state", "available_at");
CREATE INDEX "plugin_events_finished_idx"
    ON "plugin_events" ("finished_at");

ALTER TABLE "plugin_installations"
    ADD CONSTRAINT "plugin_installations_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plugin_device_bindings"
    ADD CONSTRAINT "plugin_device_bindings_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_device_bindings"
    ADD CONSTRAINT "plugin_device_bindings_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plugin_installations"
    ADD CONSTRAINT "plugin_installations_state_valid"
    CHECK ("state" IN ('enabled', 'disabled'));
ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_state_valid"
    CHECK ("state" IN ('queued', 'leased', 'completed', 'dead'));
ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_attempt_count_nonnegative"
    CHECK ("attempt_count" >= 0);
