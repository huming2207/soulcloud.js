/**
 * PostgreSQL LISTEN/NOTIFY wake-up channel for the command queue.
 *
 * Design follows the "durable outbox + NOTIFY as a signal" pattern:
 *   - the API process writes commands to `device_commands` inside a
 *     transaction and issues pg_notify on this channel (PostgreSQL only
 *     delivers the notification after the transaction commits)
 *   - the broker process LISTENs on this channel and uses it as a lossy
 *     wake-up to poll immediately instead of waiting for the next interval
 *
 * NOTIFY is NOT a reliable channel: if no listener is connected the
 * notification is dropped. Consumers must always recover from the durable
 * rows; this channel only reduces delivery latency.
 */

export const COMMAND_NOTIFY_CHANNEL = "soulcloud_commands";

/** Wake-up channel for OTA target delivery (broker ota poller). */
export const OTA_NOTIFY_CHANNEL = "soulcloud_ota";


/** Wake-up channel for device credential revocation (session kill). */
export const CREDENTIAL_REVOKED_CHANNEL = "soulcloud_credentials_revoked";

/**
 * Log event channel for the web console's realtime log stream (payload =
 * the raw_log_events row id). Lossy by design: the WS fanout falls back
 * to the REST paging API when a notification is missed.
 */
export const LOG_EVENTS_CHANNEL = "soulcloud_log_events";

/**
 * Command-result channel for the web console's realtime command stream
 * (payload = the device_commands.batch_id whose result just landed).
 * Fired inside the recording transaction, so PostgreSQL delivers it only
 * after the commit. Lossy by design: the WS fanout re-queries the durable
 * batch rows on every notification and the client falls back to REST.
 */
export const COMMAND_RESULT_CHANNEL = "soulcloud_command_results";
