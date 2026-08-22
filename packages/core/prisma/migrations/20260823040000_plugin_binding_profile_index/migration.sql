CREATE INDEX "plugin_device_bindings_installation_profile_idx"
    ON "plugin_device_bindings" ("installation_id", "profile_id", "profile_version");
