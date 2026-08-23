CREATE INDEX "plugin_entity_history_retention_idx"
    ON "plugin_entity_history" ("ingested_at", "id");
