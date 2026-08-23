ALTER TABLE "plugin_events"
    ALTER COLUMN "seq" TYPE NUMERIC(20, 0) USING "seq"::numeric;

ALTER TABLE "plugin_entity_states"
    ALTER COLUMN "sequence" TYPE NUMERIC(20, 0) USING "sequence"::numeric;

ALTER TABLE "plugin_entity_history"
    ALTER COLUMN "sequence" TYPE NUMERIC(20, 0) USING "sequence"::numeric;

ALTER TABLE "plugin_events"
    ADD CONSTRAINT "plugin_events_seq_uint64"
    CHECK ("seq" >= 0 AND "seq" <= 18446744073709551615);

ALTER TABLE "plugin_entity_states"
    ADD CONSTRAINT "plugin_entity_states_sequence_uint64"
    CHECK ("sequence" IS NULL OR ("sequence" >= 0 AND "sequence" <= 18446744073709551615));

ALTER TABLE "plugin_entity_history"
    ADD CONSTRAINT "plugin_entity_history_sequence_uint64"
    CHECK ("sequence" IS NULL OR ("sequence" >= 0 AND "sequence" <= 18446744073709551615));
