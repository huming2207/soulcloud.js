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
