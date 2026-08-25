CREATE INDEX "device_commands_execution_idempotency_idx"
    ON "device_commands" ("execution_id", "idempotency_key");
