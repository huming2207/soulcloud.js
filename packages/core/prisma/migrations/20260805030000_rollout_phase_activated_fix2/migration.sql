-- Fix ota_rollout_phases activated_at consistency (round 2): the 020000
-- check covered only active/pending, so completed/paused rows violated it
-- (same mistake class as ota_targets 070000/080000). Terminal/waiting
-- states must pass unconditionally.
ALTER TABLE "ota_rollout_phases" DROP CONSTRAINT "ota_rollout_phases_activated_consistency_check";
ALTER TABLE "ota_rollout_phases" ADD CONSTRAINT "ota_rollout_phases_activated_consistency_check"
    CHECK (("state" = 'active' AND "activated_at" IS NOT NULL)
           OR ("state" = 'pending' AND "activated_at" IS NULL)
           OR ("state" IN ('completed', 'paused')));
