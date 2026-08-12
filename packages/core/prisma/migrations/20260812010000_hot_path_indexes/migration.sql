-- Hot-path maintenance and confirmation indexes.
--
-- These predicates mirror the state-machine queries exactly. Keeping the
-- indexes partial avoids indexing terminal history, which is expected to be
-- much larger than active work.

-- stat.fw confirmation: one device's non-terminal OTA targets.
CREATE INDEX "ota_targets_active_device_idx"
    ON "ota_targets" ("device_id")
    WHERE "state" IN ('delivered', 'delivering', 'downloaded', 'installed');

-- Delivered/downloaded OTA timeout maintenance.
CREATE INDEX "ota_targets_stall_deadline_idx"
    ON "ota_targets" ("delivered_at")
    WHERE "state" IN ('delivered', 'delivering', 'downloaded');

-- Optional command delivery deadlines. NULL means no deadline and is not
-- relevant to the expiry worker.
CREATE INDEX "device_commands_delivery_deadline_idx"
    ON "device_commands" ("delivery_expires_at")
    WHERE "state" IN ('queued', 'leased', 'broker_accepted')
      AND "delivery_expires_at" IS NOT NULL;

-- The rollout worker scans only running rollouts on every pass.
CREATE INDEX "ota_rollouts_running_idx"
    ON "ota_rollouts" ("id")
    WHERE "state" = 'running';
