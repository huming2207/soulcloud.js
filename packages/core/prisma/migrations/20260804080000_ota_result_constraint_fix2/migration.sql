-- Fix ota_targets delivered_at consistency (round 2): the 070000 check
-- excluded completed/failed from both branches, which made ANY terminal
-- row violate the constraint. Terminal states must pass unconditionally.
ALTER TABLE "ota_targets" DROP CONSTRAINT "ota_targets_delivered_consistency_check";
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_delivered_consistency_check"
    CHECK (("state" IN ('delivered', 'delivering', 'downloaded', 'installed')
            AND "delivered_at" IS NOT NULL)
           OR ("state" IN ('pending', 'leased', 'expired')
               AND "delivered_at" IS NULL)
           OR ("state" IN ('completed', 'failed')));
