-- DropIndex
DROP INDEX "device_commands_batch_state_idx";

-- CreateTable
CREATE TABLE "firmware_artifacts" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "buildId" VARCHAR(64) NOT NULL,
    "version" VARCHAR(255),
    "elf_bytes" BYTEA NOT NULL,
    "elf_size" INTEGER NOT NULL,
    "import_state" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "import_error" TEXT,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firmware_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_log_strings" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "address" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "firmware_log_strings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_log_events" (
    "id" BIGSERIAL NOT NULL,
    "device_id" UUID NOT NULL,
    "artifact_id" UUID,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_time_ms" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "packet_type" INTEGER NOT NULL,
    "level" INTEGER,
    "tag_id" INTEGER,
    "fmt_id" INTEGER,
    "raw_packet" BYTEA NOT NULL,
    "decode_state" VARCHAR(32) NOT NULL DEFAULT 'unknown_fw',

    CONSTRAINT "raw_log_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_firmware_state" (
    "device_id" UUID NOT NULL,
    "fw_hash" VARCHAR(64) NOT NULL,
    "reported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_firmware_state_pkey" PRIMARY KEY ("device_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "firmware_artifacts_buildId_key" ON "firmware_artifacts"("buildId");

-- CreateIndex
CREATE INDEX "firmware_artifacts_project_id_uploaded_at_idx" ON "firmware_artifacts"("project_id", "uploaded_at");

-- CreateIndex
CREATE INDEX "firmware_log_strings_artifact_id_kind_idx" ON "firmware_log_strings"("artifact_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_log_strings_unique" ON "firmware_log_strings"("artifact_id", "address", "kind");

-- CreateIndex
CREATE INDEX "raw_log_events_device_idx" ON "raw_log_events"("device_id", "id");

-- CreateIndex
CREATE INDEX "raw_log_events_artifact_idx" ON "raw_log_events"("artifact_id", "tag_id", "id");

-- CreateIndex
CREATE INDEX "raw_log_events_time_idx" ON "raw_log_events"("received_at");

-- AddForeignKey
ALTER TABLE "firmware_artifacts" ADD CONSTRAINT "firmware_artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firmware_log_strings" ADD CONSTRAINT "firmware_log_strings_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "firmware_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_log_events" ADD CONSTRAINT "raw_log_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_log_events" ADD CONSTRAINT "raw_log_events_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "firmware_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_firmware_state" ADD CONSTRAINT "device_firmware_state_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
