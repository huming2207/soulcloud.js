-- Command provenance is platform metadata only. The MessagePack command
-- payload sent to devices remains unchanged.
ALTER TABLE "device_commands"
    ADD COLUMN "origin_type" VARCHAR(16) NOT NULL DEFAULT 'human',
    ADD COLUMN "origin_user_id" UUID,
    ADD COLUMN "plugin_installation_id" UUID,
    ADD COLUMN "plugin_version" VARCHAR(128),
    ADD COLUMN "manifest_hash" CHAR(64),
    ADD COLUMN "execution_id" UUID,
    ADD COLUMN "correlation_id" UUID,
    ADD COLUMN "idempotency_key" VARCHAR(128),
    ADD COLUMN "cancel_requested_at" TIMESTAMPTZ;

ALTER TABLE "device_commands"
    ADD CONSTRAINT "device_commands_origin_type_valid"
    CHECK ("origin_type" IN ('human', 'plugin', 'llm_agent'));

ALTER TABLE "device_commands"
    ADD CONSTRAINT "device_commands_origin_user_id_fkey"
    FOREIGN KEY ("origin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "device_commands"
    ADD CONSTRAINT "device_commands_plugin_installation_id_fkey"
    FOREIGN KEY ("plugin_installation_id") REFERENCES "plugin_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "device_commands_origin_created_idx"
    ON "device_commands" ("origin_type", "created_at");
CREATE INDEX "device_commands_plugin_created_idx"
    ON "device_commands" ("plugin_installation_id", "created_at");
CREATE INDEX "device_commands_execution_idx"
    ON "device_commands" ("execution_id");
