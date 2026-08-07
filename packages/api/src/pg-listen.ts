/**
 * Shared pg LISTEN connection manager for the realtime WebSocket endpoints
 * (log stream + command stream).
 *
 * Both streams need identical plumbing: a process-wide pg Client that
 * LISTENs on one channel and reconnects after failures. NOTIFY is lossy
 * by design — if no listener is connected the notification is dropped and
 * consumers must recover from the durable rows (REST fallback, or the WS
 * fanout re-queries the rows on every notification it does receive).
 */

import { Client } from "pg";

export interface PgListenLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface PgChannelListener {
  /** Starts the LISTEN connection (idempotent; the first call wins). */
  start(): void;
  /**
   * Closes the LISTEN connection. Terminal: a new listener must be
   * created for the channel (each stream module owns its singleton).
   */
  close(): Promise<void>;
}

/**
 * Creates a listener for one PostgreSQL channel. The connection starts
 * lazily on the first `start()` and reconnects with a 1s delay after any
 * failure; `onNotification` is called with the raw payload string.
 */
export function createPgChannelListener(
  databaseUrl: string,
  channel: string,
  onNotification: (payload: string | undefined) => void,
  log: PgListenLog,
): PgChannelListener {
  let client: Client | null = null;
  let closed = false;
  let started = false;

  async function listen(): Promise<void> {
    if (closed || client) return;
    const c = new Client({ connectionString: databaseUrl });
    client = c;
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
      c.on("notification", (msg) => {
        onNotification(msg.payload ?? undefined);
      });
      c.on("error", (err) => {
        log.warn("pg listener error", { channel, error: (err as Error).message });
        void reconnect();
      });
      log.warn("pg listener ready", { channel });
    } catch (error) {
      log.warn("pg listener connect failed", {
        channel,
        error: (error as Error).message,
      });
      void reconnect();
    }
  }

  async function reconnect(): Promise<void> {
    // a pg Client cannot be reused after an error
    if (client) {
      try {
        await client.end();
      } catch {
        // already dead
      }
      client = null;
    }
    if (closed) return;
    await Bun.sleep(1000);
    void listen();
  }

  return {
    start() {
      if (started) return;
      started = true;
      void listen();
    },
    async close() {
      closed = true;
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore
        }
        client = null;
      }
    },
  };
}
