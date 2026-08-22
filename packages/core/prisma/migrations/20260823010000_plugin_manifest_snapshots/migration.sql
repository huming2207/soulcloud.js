CREATE TABLE "plugin_manifest_snapshots" (
    "id" UUID NOT NULL,
    "plugin_id" VARCHAR(128) NOT NULL,
    "plugin_version" VARCHAR(128) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "canonical_manifest" JSONB NOT NULL,
    "api_version" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_manifest_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_manifest_snapshots_plugin_version_unique"
    ON "plugin_manifest_snapshots" ("plugin_id", "plugin_version");
CREATE INDEX "plugin_manifest_snapshots_plugin_id_first_seen_at_idx"
    ON "plugin_manifest_snapshots" ("plugin_id", "first_seen_at");
