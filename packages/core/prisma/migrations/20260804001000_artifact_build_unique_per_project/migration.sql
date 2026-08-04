-- M3: build identity unique per project (not global), so cross-project
-- reuse cannot leak artifact references between tenants.
-- Prisma 7 renders @unique as a unique INDEX, not a constraint.
DROP INDEX "firmware_artifacts_buildId_key";
CREATE UNIQUE INDEX "firmware_artifacts_project_build_unique" ON "firmware_artifacts"("project_id", "buildId");
