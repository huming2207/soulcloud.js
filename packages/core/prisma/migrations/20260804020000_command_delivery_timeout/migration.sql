-- M2: per-command delivery timeout.
--  * new column delivery_expires_at (NULL = never expires)
--  * state enum gains 'delivery_failed' (terminal: release the per-device
--    queue without a device result)
ALTER TABLE "device_commands" ADD COLUMN "delivery_expires_at" TIMESTAMPTZ;
ALTER TABLE "device_commands" DROP CONSTRAINT "device_commands_state_valid";
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_state_valid"
    CHECK (state IN ('queued', 'leased', 'broker_accepted', 'device_completed', 'delivery_failed'));
