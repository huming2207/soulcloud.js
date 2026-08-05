-- OTA rollout: phased firmware deployment (proposal 19).
-- Three tables: rollout (container + per-rollout gating settings), pool
-- (device snapshot), phases (each activation creates an ota_job).
CREATE TABLE "ota_rollouts" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "from_release_id" UUID,
    "state" VARCHAR(32) NOT NULL DEFAULT 'running',
    "strategy" VARCHAR(32) NOT NULL,
    "success_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "min_sample" INTEGER NOT NULL DEFAULT 10,
    "phase_timeout_hours" INTEGER NOT NULL DEFAULT 24,
    "stuck_hours" INTEGER NOT NULL DEFAULT 6,
    "manual_approval" BOOLEAN NOT NULL DEFAULT false,
    "rollback_job_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ota_rollouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ota_rollouts_state_check"
        CHECK ("state" IN ('running', 'paused', 'aborted', 'completed')),
    CONSTRAINT "ota_rollouts_strategy_check"
        CHECK ("strategy" IN ('auto', 'grouped')),
    CONSTRAINT "ota_rollouts_success_ratio_check"
        CHECK ("success_ratio" > 0 AND "success_ratio" <= 1),
    CONSTRAINT "ota_rollouts_min_sample_check"
        CHECK ("min_sample" >= 0),
    CONSTRAINT "ota_rollouts_timeout_checks"
        CHECK ("phase_timeout_hours" > 0 AND "stuck_hours" > 0)
);
CREATE UNIQUE INDEX "ota_rollouts_rollback_job_id_key" ON "ota_rollouts"("rollback_job_id");
CREATE INDEX "ota_rollouts_project_id_created_at_idx" ON "ota_rollouts"("project_id", "created_at");
ALTER TABLE "ota_rollouts" ADD CONSTRAINT "ota_rollouts_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ota_rollouts" ADD CONSTRAINT "ota_rollouts_release_id_fkey"
    FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ota_rollouts" ADD CONSTRAINT "ota_rollouts_from_release_id_fkey"
    FOREIGN KEY ("from_release_id") REFERENCES "firmware_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ota_rollouts" ADD CONSTRAINT "ota_rollouts_rollback_job_id_fkey"
    FOREIGN KEY ("rollback_job_id") REFERENCES "ota_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ota_rollout_pool" (
    "id" UUID NOT NULL,
    "rollout_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "sort_idx" INTEGER NOT NULL,
    CONSTRAINT "ota_rollout_pool_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ota_rollout_pool_sort_idx_check" CHECK ("sort_idx" >= 0)
);
CREATE UNIQUE INDEX "ota_rollout_pool_rollout_device_unique" ON "ota_rollout_pool"("rollout_id", "device_id");
CREATE UNIQUE INDEX "ota_rollout_pool_rollout_sort_unique" ON "ota_rollout_pool"("rollout_id", "sort_idx");
ALTER TABLE "ota_rollout_pool" ADD CONSTRAINT "ota_rollout_pool_rollout_id_fkey"
    FOREIGN KEY ("rollout_id") REFERENCES "ota_rollouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ota_rollout_pool" ADD CONSTRAINT "ota_rollout_pool_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ota_rollout_phases" (
    "id" UUID NOT NULL,
    "rollout_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "ratio" DOUBLE PRECISION,
    "group_id" INTEGER,
    "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "job_id" UUID,
    "activated_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    CONSTRAINT "ota_rollout_phases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ota_rollout_phases_index_check" CHECK ("index" > 0),
    CONSTRAINT "ota_rollout_phases_state_check"
        CHECK ("state" IN ('pending', 'active', 'completed', 'paused')),
    CONSTRAINT "ota_rollout_phases_ratio_check"
        CHECK ("ratio" IS NULL OR ("ratio" > 0 AND "ratio" <= 1)),
    CONSTRAINT "ota_rollout_phases_activated_consistency_check"
        CHECK (("state" = 'active' AND "activated_at" IS NOT NULL)
               OR ("state" <> 'active' AND "activated_at" IS NULL)),
    CONSTRAINT "ota_rollout_phases_completed_consistency_check"
        CHECK (("state" = 'completed' AND "completed_at" IS NOT NULL)
               OR ("state" <> 'completed' AND "completed_at" IS NULL))
);
CREATE UNIQUE INDEX "ota_rollout_phases_rollout_id_index_key" ON "ota_rollout_phases"("rollout_id", "index");
CREATE UNIQUE INDEX "ota_rollout_phases_job_id_key" ON "ota_rollout_phases"("job_id");
ALTER TABLE "ota_rollout_phases" ADD CONSTRAINT "ota_rollout_phases_rollout_id_fkey"
    FOREIGN KEY ("rollout_id") REFERENCES "ota_rollouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ota_rollout_phases" ADD CONSTRAINT "ota_rollout_phases_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "ota_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
