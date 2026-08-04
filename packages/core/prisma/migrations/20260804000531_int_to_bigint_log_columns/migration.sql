-- AlterTable
ALTER TABLE "firmware_log_strings" ALTER COLUMN "address" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "raw_log_events" ALTER COLUMN "device_time_ms" SET DATA TYPE BIGINT,
ALTER COLUMN "tag_id" SET DATA TYPE BIGINT,
ALTER COLUMN "fmt_id" SET DATA TYPE BIGINT;
