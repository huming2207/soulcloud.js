-- OTA result acknowledgement: terminal target states (completed/failed),
-- device acknowledgement fields, and the delivering/downloaded/installed
-- intermediate states driven by device signals (see proposal 18).
ALTER TABLE "ota_targets"
    ADD COLUMN "confirmed_at" TIMESTAMPTZ,
    ADD COLUMN "result_code" INTEGER,
    ADD COLUMN "result_message" VARCHAR(512);

ALTER TABLE "ota_targets" DROP CONSTRAINT "ota_targets_state_check";
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_state_check"
    CHECK ("state" IN ('pending', 'leased', 'delivered', 'delivering',
                       'downloaded', 'installed', 'expired', 'completed', 'failed'));

-- delivered and its successors imply the notice was published
ALTER TABLE "ota_targets" DROP CONSTRAINT "ota_targets_delivered_consistency_check";
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_delivered_consistency_check"
    CHECK (("state" IN ('delivered', 'delivering', 'downloaded', 'installed')
            AND "delivered_at" IS NOT NULL)
           OR ("state" NOT IN ('delivered', 'delivering', 'downloaded', 'installed')
               AND "delivered_at" IS NULL));

-- terminal states carry a device acknowledgement
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_confirmed_consistency_check"
    CHECK (("state" IN ('completed', 'failed') AND "confirmed_at" IS NOT NULL)
           OR ("state" NOT IN ('completed', 'failed') AND "confirmed_at" IS NULL));

-- result code semantics: completed = 0, failed = negative; intermediate
-- states carry no result at all
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_result_consistency_check"
    CHECK (("state" = 'completed' AND "result_code" = 0)
           OR ("state" = 'failed' AND "result_code" < 0)
           OR ("state" NOT IN ('completed', 'failed')
               AND "result_code" IS NULL AND "result_message" IS NULL));
