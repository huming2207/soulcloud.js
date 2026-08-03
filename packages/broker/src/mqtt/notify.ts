/**
 * PostgreSQL LISTEN/NOTIFY wake-up listener for the broker process.
 *
 * A dedicated pg connection LISTENs on the command channel. Every
 * notification triggers the poller to run immediately instead of waiting
 * for the next poll interval. The notification is a lossy hint: the poller
 * always recovers work from the durable `device_commands` rows, so a
 * dropped notification only costs latency, never correctness.
 */

import { Client } from "pg";
import { COMMAND_NOTIFY_CHANNEL } from "@soulcloud/core";

export interface CommandNotifier {
  /** Stops listening and closes the connection. */
  close: () => Promise<void>;
}

export interface NotifierLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
}

const RECONNECT_DELAY_MS = 1000;

/**
 * Starts listening for command notifications.
 *
 * The connection reconnects automatically after failures (LISTEN state is
 * re-established). The wake-up callback must never throw.
 */
export async function startCommandNotifier(
  databaseUrl: string,
  onWakeup: () => void,
  log: NotifierLog,
): Promise<CommandNotifier> {
  const client = new Client({ connectionString: databaseUrl });
  let closed = false;
  let listening = false;

  client.on("notification", (message) => {
    if (message.channel === COMMAND_NOTIFY_CHANNEL) {
      log.info("command notification received", {
        batchId: message.payload ?? undefined,
      });
      onWakeup();
    }
  });

  client.on("error", (error) => {
    log.warn("command notify connection error; will reconnect", {
      error: error.message,
    });
    listening = false;
    void scheduleReconnect();
  });

  async function listen(): Promise<void> {
    await client.connect();
    await client.query(`LISTEN ${COMMAND_NOTIFY_CHANNEL}`);
    listening = true;
    log.info(`listening for command notifications on "${COMMAND_NOTIFY_CHANNEL}"`);
  }

  async function scheduleReconnect(): Promise<void> {
    if (closed) return;
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    if (closed) return;
    try {
      await listen();
    } catch (error) {
      log.warn("command notify reconnect failed; retrying", {
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
        await client.end();
      } catch {
        // connection may already be broken
      }
    },
  };
}
