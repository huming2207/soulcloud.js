-- Expiry is maintained by the database-clock maintenance query.  A capability
-- is therefore allowed to become expired before that query clears its lease;
-- checking expires_at against created_at at every update would make the
-- normal expiry transition impossible.
ALTER TABLE "debug_executions"
    DROP CONSTRAINT IF EXISTS "debug_executions_expiry_after_creation";
ALTER TABLE "debug_executions"
    DROP CONSTRAINT IF EXISTS "debug_executions_lease_before_expiry";
