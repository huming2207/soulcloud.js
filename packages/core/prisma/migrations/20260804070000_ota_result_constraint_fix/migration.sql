-- Fix ota_targets delivered_at consistency: terminal states
-- (completed/failed) may transition FROM delivered/delivering/downloaded/
-- installed (which carry delivered_at), so they must not be constrained.
ALTER TABLE "ota_targets" DROP CONSTRAINT "ota_targets_delivered_consistency_check";
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_delivered_consistency_check"
    CHECK (("state" IN ('delivered', 'delivering', 'downloaded', 'installed')
            AND "delivered_at" IS NOT NULL)
           OR ("state" IN ('pending', 'leased', 'expired')
               AND "delivered_at" IS NULL));
