-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "website_url" TEXT NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "device_uid" VARCHAR(128) NOT NULL,
    "assigned_id" VARCHAR(128) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "next_command_sequence" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_users" (
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "organisation_users_pkey" PRIMARY KEY ("organisation_id","user_id")
);

-- CreateTable
CREATE TABLE "organisation_projects" (
    "organisation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,

    CONSTRAINT "organisation_projects_pkey" PRIMARY KEY ("organisation_id","project_id")
);

-- CreateTable
CREATE TABLE "command_batches" (
    "id" UUID NOT NULL,
    "device_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "payload" BYTEA NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ,
    "broker_accepted_at" TIMESTAMPTZ,
    "result_code" INTEGER,
    "result_packet" BYTEA,
    "device_completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_device_uid_key" ON "devices"("device_uid");

-- CreateIndex
CREATE UNIQUE INDEX "devices_project_assigned_id_unique" ON "devices"("project_id", "assigned_id");

-- CreateIndex
CREATE INDEX "organisation_users_user_id_idx" ON "organisation_users"("user_id");

-- CreateIndex
CREATE INDEX "organisation_projects_project_id_idx" ON "organisation_projects"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_commands_batch_device_unique" ON "device_commands"("batch_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_commands_device_sequence_unique" ON "device_commands"("device_id", "sequence");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_users" ADD CONSTRAINT "organisation_users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_users" ADD CONSTRAINT "organisation_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_projects" ADD CONSTRAINT "organisation_projects_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_projects" ADD CONSTRAINT "organisation_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "command_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Soulcloud CHECK constraints and query indexes (Prisma cannot express these
-- natively; they mirror the original Diesel schema exactly).

ALTER TABLE "users" ADD CONSTRAINT "users_username_not_blank" CHECK (btrim(username) <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_password_hash_not_blank" CHECK (btrim(password_hash) <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_email_not_blank" CHECK (btrim(email) <> '');

ALTER TABLE "organisations" ADD CONSTRAINT "organisations_name_not_blank" CHECK (btrim(name) <> '');
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_website_url_not_blank" CHECK (btrim(website_url) <> '');

ALTER TABLE "projects" ADD CONSTRAINT "projects_name_not_blank" CHECK (btrim(name) <> '');

ALTER TABLE "devices" ADD CONSTRAINT "devices_device_uid_not_blank" CHECK (btrim(device_uid) <> '');
ALTER TABLE "devices" ADD CONSTRAINT "devices_assigned_id_not_blank" CHECK (btrim(assigned_id) <> '');
ALTER TABLE "devices" ADD CONSTRAINT "devices_password_hash_not_blank" CHECK (btrim(password_hash) <> '');
ALTER TABLE "devices" ADD CONSTRAINT "devices_next_command_sequence_positive" CHECK (next_command_sequence > 0);

ALTER TABLE "command_batches" ADD CONSTRAINT "command_batches_device_count_positive" CHECK (device_count > 0);

ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_sequence_positive" CHECK (sequence > 0);
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_state_valid"
    CHECK (state IN ('queued', 'leased', 'broker_accepted', 'device_completed'));
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_attempt_count_nonnegative" CHECK (attempt_count >= 0);
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_lease_consistent" CHECK (
    (state = 'leased' AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_expires_at IS NULL)
);
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_broker_acceptance_consistent" CHECK (
    (state IN ('broker_accepted', 'device_completed') AND broker_accepted_at IS NOT NULL)
    OR (state NOT IN ('broker_accepted', 'device_completed') AND broker_accepted_at IS NULL)
);
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_result_consistent" CHECK (
    (state = 'device_completed' AND result_code IS NOT NULL AND result_packet IS NOT NULL AND device_completed_at IS NOT NULL)
    OR (state <> 'device_completed' AND result_code IS NULL AND result_packet IS NULL AND device_completed_at IS NULL)
);

CREATE INDEX device_commands_claim_idx
    ON device_commands (available_at, created_at, id)
    WHERE state IN ('queued', 'leased');

CREATE INDEX device_commands_device_pending_idx
    ON device_commands (device_id, created_at, id)
    WHERE state IN ('queued', 'leased', 'broker_accepted');

CREATE INDEX device_commands_batch_state_idx
    ON device_commands (batch_id, state);
