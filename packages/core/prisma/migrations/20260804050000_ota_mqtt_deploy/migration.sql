-- OTA MQTT deploy: per-device short-JWT download credentials delivered over
-- the MQTT ota topic (devices fetch the bin over HTTP themselves).
-- Replaces the single-use firmware_download_tokens scheme (proposal 16 rev).
DROP TABLE "firmware_download_tokens";

CREATE TABLE "ota_jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ota_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ota_jobs_project_id_created_at_idx" ON "ota_jobs"("project_id", "created_at");
ALTER TABLE "ota_jobs" ADD CONSTRAINT "ota_jobs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ota_jobs" ADD CONSTRAINT "ota_jobs_release_id_fkey"
    FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- created_by references users but is intentionally not a FK (user deletion
-- policy is out of scope; the id is kept for audit).

CREATE TABLE "ota_targets" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "lease_expires_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ota_targets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ota_targets_state_check"
        CHECK ("state" IN ('pending', 'leased', 'delivered', 'expired')),
    CONSTRAINT "ota_targets_lease_consistency_check"
        CHECK (("state" = 'leased' AND "lease_expires_at" IS NOT NULL)
               OR ("state" <> 'leased' AND "lease_expires_at" IS NULL)),
    CONSTRAINT "ota_targets_delivered_consistency_check"
        CHECK (("state" = 'delivered' AND "delivered_at" IS NOT NULL)
               OR ("state" <> 'delivered' AND "delivered_at" IS NULL))
);
CREATE INDEX "ota_targets_state_expires_at_idx" ON "ota_targets"("state", "expires_at");
CREATE INDEX "ota_targets_job_id_idx" ON "ota_targets"("job_id");
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "ota_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
