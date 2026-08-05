-- Rollout support columns: ota_targets.installed_at (stall judgement) and
-- ota_rollout_phases.target_count (device slicing per phase).
ALTER TABLE "ota_targets" ADD COLUMN "installed_at" TIMESTAMPTZ;
ALTER TABLE "ota_rollout_phases" ADD COLUMN "target_count" INTEGER;
UPDATE "ota_rollout_phases" SET "target_count" = 0 WHERE "target_count" IS NULL;
ALTER TABLE "ota_rollout_phases" ALTER COLUMN "target_count" SET NOT NULL;
ALTER TABLE "ota_rollout_phases" ADD CONSTRAINT "ota_rollout_phases_target_count_check"
    CHECK ("target_count" > 0);
