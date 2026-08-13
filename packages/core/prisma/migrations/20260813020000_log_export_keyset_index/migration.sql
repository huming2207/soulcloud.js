-- Keyset index for the time-ranged log export (perf audit).
--
-- The export endpoint pages by (received_at, id) within one device and a
-- [from, to] window. The previous plan picked the primary key and scanned
-- every row of the device's history before the window (measured: 990k
-- rows filtered, ~120MB read, 140ms per request on a 1M-row device).
-- This index turns the same query into a pure index scan (~0.1ms).
CREATE INDEX "raw_log_events_device_time_id_idx"
    ON "raw_log_events" ("device_id", "received_at", "id");
