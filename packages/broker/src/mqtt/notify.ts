/**
 * PostgreSQL LISTEN/NOTIFY listener for the broker process.
 *
 * One dedicated pg connection LISTENs on multiple channels:
 *
 *   - `soulcloud_commands`: lossy wake-up for the command poller (the
 *     poller always recovers from the durable rows; a dropped notification
 *     only costs latency)
 *   - `soulcloud_credentials_revoked`: device session kill (payload is the
 *     device UID); if it is dropped, the revocation still refuses
 *     reconnects, so a live session may outlive the revoke until it
 *     disconnects - correctness is preserved, only immediacy is lost
 *
 * The connection reconnects automatically after failures (LISTEN state is
 * re-established). Callbacks must never throw.
 */

import { Client } from "pg";
import {
  COMMAND_NOTIFY_CHANNEL,
  CREDENTIAL_REVOKED_CHANNEL,
} from "@soulcloud/core";

export interface Notifier {
  /** Stops listening and closes the connection. */
  close: () => Promise<void>;
}

export interface NotifierLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface NotifierHandlers {
  /** Called for every command-channel notification (payload = batch id). */
  onCommand: (batchId: string | null) => void;
  /** Called for every credential-revocation notification (payload = device UID). */
  onCredentialRevoked: (deviceUid: string) => void;
}

const RECONNECT_DELAY_MS = 1000;

/**
 * Starts listening for notifications on the broker channels.
 *
 * A pg Client cannot be re-connected after an error; each reconnect
 * creates a fresh Client (the previous one is ended first).
 */
export async function startNotifier(
  databaseUrl: string,
  handlers: NotifierHandlers,
  log: NotifierLog,
): Promise<Notifier> {
  let closed = false;
  let client: Client | null = null;

  async function listen(): Promise<void> {
    const c = new Client({ connectionString: databaseUrl });

    c.on("notification", (message) => {
      if (message.channel === COMMAND_NOTIFY_CHANNEL) {
        log.info("command notification received", {
          batchId: message.payload ?? undefined,
        });
        handlers.onCommand(message.payload ?? null);
      } else if (message.channel === CREDENTIAL_REVOKED_CHANNEL) {
        if (message.payload) {
          log.info("credential revocation notification received", {
            deviceUid: message.payload,
          });
          handlers.onCredentialRevoked(message.payload);
        }
      }
    });

    // a broken connection emits 'error' then 'end'; schedule a fresh listen
    c.on("error", (error) => {
      log.warn("notify connection error; will reconnect", {
        error: error.message,
      });
      void c.end().catch(() => {});
      void scheduleReconnect();
    });

    await c.connect();
    // PostgreSQL LISTEN accepts one channel per statement
    await c.query(`LISTEN ${COMMAND_NOTIFY_CHANNEL}`);
    await c.query(`LISTEN ${CREDENTIAL_REVOKED_CHANNEL}`);
    client = c;
    log.info(
      `listening for notifications on "${COMMAND_NOTIFY_CHANNEL}" and "${CREDENTIAL_REVOKED_CHANNEL}"`,
    );
  }

  async function scheduleReconnect(): Promise<void> {
    if (closed) return;
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    if (closed) return;
    try {
      await listen();
    } catch (error) {
      log.warn("notify reconnect failed; retrying", {
        error: (error as Error).message,
      });
      void scheduleReconnect();
    }
  }

  await listen();

  return {
    close: async () => {
      closed = true;
      try {
        await client?.end();
      } catch {
        // connection may already be broken
      }
    },
  };
}
