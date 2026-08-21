-- Allow several independently configured installations of the same plugin in
-- one project. The installation id, not (project, plugin), is the identity.
DROP INDEX IF EXISTS "plugin_installations_project_plugin_unique";

-- Descriptor revisions are scoped by profile version. Existing deployments
-- only have the original v1 profiles, so v1 is a safe backfill value.
ALTER TABLE "entity_descriptor_revisions"
  ADD COLUMN IF NOT EXISTS "profile_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "entity_descriptor_revisions"
  ALTER COLUMN "profile_version" DROP DEFAULT;
DROP INDEX IF EXISTS "entity_descriptor_revisions_identity_unique";
CREATE UNIQUE INDEX "entity_descriptor_revisions_identity_unique"
  ON "entity_descriptor_revisions"("plugin_id", "profile_id", "profile_version", "entity_key", "revision");
DROP INDEX IF EXISTS "entity_descriptor_revisions_plugin_id_profile_id_entity_key_idx";
DROP INDEX IF EXISTS "entity_descriptor_revisions_plugin_id_profile_id_profile_versio";
CREATE INDEX "entity_descriptor_revisions_plugin_id_profile_id_profile_version_entity_key_idx"
  ON "entity_descriptor_revisions"("plugin_id", "profile_id", "profile_version", "entity_key");

-- Freeze all routing inputs at enqueue time. This prevents a pending event
-- from being executed with a later device binding or installation config.
ALTER TABLE "plugin_events"
  ADD COLUMN IF NOT EXISTS "project_id" UUID,
  ADD COLUMN IF NOT EXISTS "device_uid" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "plugin_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "plugin_version" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "profile_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "profile_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "installation_config" JSONB;

UPDATE "plugin_events" pe
SET "project_id" = d."project_id",
    "device_uid" = d."device_uid",
    "plugin_id" = pi."plugin_id",
    "plugin_version" = pi."configured_plugin_version",
    "profile_id" = COALESCE(d."profile_id", 'generic'),
    "profile_version" = COALESCE(d."profile_version", 1),
    "installation_config" = pi."config_json"
FROM "devices" d, "plugin_installations" pi
WHERE d."id" = pe."device_id"
  AND pi."id" = pe."plugin_installation_id";

ALTER TABLE "plugin_events"
  ALTER COLUMN "project_id" SET NOT NULL,
  ALTER COLUMN "device_uid" SET NOT NULL,
  ALTER COLUMN "plugin_id" SET NOT NULL,
  ALTER COLUMN "plugin_version" SET NOT NULL,
  ALTER COLUMN "profile_id" SET NOT NULL,
  ALTER COLUMN "profile_version" SET NOT NULL;

DROP INDEX IF EXISTS "plugin_events_idempotency_unique";
CREATE INDEX IF NOT EXISTS "plugin_events_device_idempotency_idx"
  ON "plugin_events"("device_id", "idempotency_key");
CREATE UNIQUE INDEX "plugin_events_device_idempotency_unique"
  ON "plugin_events"("device_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
