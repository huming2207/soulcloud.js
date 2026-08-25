CREATE TABLE "debug_executions" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "initiating_user_id" UUID NOT NULL,
    "plugin_id" VARCHAR(128) NOT NULL,
    "plugin_version" VARCHAR(128) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "allowed_capabilities" JSONB NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'active',
    "device_lease_expires_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "debug_executions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_initiating_user_id_fkey"
    FOREIGN KEY ("initiating_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_commands"
    ADD CONSTRAINT "device_commands_execution_id_fkey"
    FOREIGN KEY ("execution_id") REFERENCES "debug_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_state_valid"
    CHECK ("state" IN ('active', 'paused', 'cancelling', 'completed', 'failed', 'expired'));
ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_allowed_capabilities_array"
    CHECK (jsonb_typeof("allowed_capabilities") = 'array');
ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_expiry_after_creation"
    CHECK ("expires_at" > "created_at");
ALTER TABLE "debug_executions"
    ADD CONSTRAINT "debug_executions_lease_before_expiry"
    CHECK ("device_lease_expires_at" IS NULL OR "device_lease_expires_at" <= "expires_at");

CREATE UNIQUE INDEX "debug_executions_token_hash_unique"
    ON "debug_executions" ("token_hash");
CREATE UNIQUE INDEX "debug_executions_active_device_unique"
    ON "debug_executions" ("device_id")
    WHERE "state" IN ('active', 'cancelling');
CREATE INDEX "debug_executions_device_state_idx"
    ON "debug_executions" ("device_id", "state");
CREATE INDEX "debug_executions_installation_state_idx"
    ON "debug_executions" ("installation_id", "state");
CREATE INDEX "debug_executions_state_expiry_idx"
    ON "debug_executions" ("state", "expires_at");
