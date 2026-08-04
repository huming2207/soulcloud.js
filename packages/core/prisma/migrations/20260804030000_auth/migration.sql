-- G group: human user auth (JWT + server-side refresh tokens), user-project
-- membership, and device credential revocation.
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "rotated_from" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_projects" (
    "user_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    CONSTRAINT "user_projects_pkey" PRIMARY KEY ("user_id","project_id")
);
CREATE INDEX "user_projects_project_id_idx" ON "user_projects"("project_id");
ALTER TABLE "user_projects" ADD CONSTRAINT "user_projects_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_projects" ADD CONSTRAINT "user_projects_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "devices" ADD COLUMN "auth_revoked" BOOLEAN NOT NULL DEFAULT false;
