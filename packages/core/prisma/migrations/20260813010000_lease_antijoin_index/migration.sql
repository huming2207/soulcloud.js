-- Anti-join index for leaseNext's NOT EXISTS probe (perf audit).
--
-- The lease query (core/src/queue/lease.ts) checks, for every candidate
-- row, whether an earlier command (smaller sequence) of the same device is
-- still in flight: `earlier.device_id = dc.device_id AND earlier.sequence
-- < dc.sequence AND earlier.state IN ('queued','leased','broker_accepted')`.
-- `sequence` was not part of any index, so every probe fetched the row
-- from the heap. This partial index covers exactly the states the
-- anti-join scans and makes the probe index-only.
CREATE INDEX "device_commands_device_seq_pending_idx"
    ON "device_commands" ("device_id", "sequence")
    WHERE "state" IN ('queued', 'leased', 'broker_accepted');
