-- Fix ota_rollout_phases activated_at consistency: completed/paused phases
-- were activated before, so they must not be forced to NULL. Only pending
-- must be NULL; active must be set.
ALTER TABLE "ota_rollout_phases" DROP CONSTRAINT "ota_rollout_phases_activated_consistency_check";
ALTER TABLE "ota_rollout_phases" ADD CONSTRAINT "ota_rollout_phases_activated_consistency_check"
    CHECK (("state" = 'active' AND "activated_at" IS NOT NULL)
           OR ("state" = 'pending' AND "activated_at" IS NULL));
