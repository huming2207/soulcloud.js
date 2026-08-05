-- Runs on first database initialisation only (empty volume). The test
-- suite also creates this database idempotently via scripts/prepare-test-db.ts.
CREATE DATABASE soulcloud_test OWNER soulcloud;
