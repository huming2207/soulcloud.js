-- OTA firmware releases: a distributable bin image, optionally tied to an
-- ELF artifact (build identity = ELF hash, on9log decoding).
CREATE TABLE "firmware_releases" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "artifact_id" UUID,
    "bin_hash" VARCHAR(64) NOT NULL,
    "bin_bytes" BYTEA NOT NULL,
    "bin_size" INTEGER NOT NULL,
    "version" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "firmware_releases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "firmware_releases_project_bin_unique"
    ON "firmware_releases"("project_id", "bin_hash");
CREATE INDEX "firmware_releases_project_id_created_at_idx"
    ON "firmware_releases"("project_id", "created_at");
ALTER TABLE "firmware_releases" ADD CONSTRAINT "firmware_releases_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "firmware_releases" ADD CONSTRAINT "firmware_releases_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "firmware_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Single-use, short-lived download credentials for release bins.
CREATE TABLE "firmware_download_tokens" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "firmware_download_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "firmware_download_tokens_token_hash_key"
    ON "firmware_download_tokens"("token_hash");
CREATE INDEX "firmware_download_tokens_release_id_expires_at_idx"
    ON "firmware_download_tokens"("release_id", "expires_at");
ALTER TABLE "firmware_download_tokens" ADD CONSTRAINT "firmware_download_tokens_release_id_fkey"
    FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
