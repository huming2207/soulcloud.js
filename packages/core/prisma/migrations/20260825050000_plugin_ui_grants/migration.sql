CREATE TABLE "plugin_ui_grants" (
    "nonce" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_ui_grants_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "plugin_ui_grants_expiry_idx"
    ON "plugin_ui_grants" ("expires_at");
