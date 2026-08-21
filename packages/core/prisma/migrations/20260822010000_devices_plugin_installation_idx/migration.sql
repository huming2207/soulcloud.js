-- Supports installation device counts, reconciliation and FK maintenance.
CREATE INDEX "devices_plugin_installation_id_idx"
  ON "devices"("plugin_installation_id");
