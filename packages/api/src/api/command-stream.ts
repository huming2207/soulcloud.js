/**
 * Realtime command-batch stream for the web console
 * (GET /v1/ws/commands?batch_id=<uuid>, WebSocket upgrade).
 *
 * Authentication rides the Sec-WebSocket-Protocol header exactly like the
 * log stream: the client connects with subprotocols
 * `["soulcloud", "<access token>"]`. The upgrade is rejected (401/404)
 * unless the token is valid, the batch exists and every target device's
 * project is one the user is a member of (same rule as
 * GET /v1/command-batches/:id).
 *
 * Delivery model: the command queue notifies `COMMAND_RESULT_CHANNEL`
 * (payload = batch id) inside the result-recording transaction, so the
 * notification only arrives after the commit. The hub re-queries the
 * batch (same shape as the REST detail endpoint) and pushes
 * `{ type: "batch", ...detail }`. NOTIFY is lossy: a missed notification
 * costs latency only — clients fall back to the REST batch endpoint.
 *
 * Burst notifications for the same batch are debounced: a notify arms a
 * per-batch timer (DEBOUNCE_MS, default 250ms, configurable via hub
 * options) and further notifies within the window reset it, so N results
 * that land together cost one re-query + one full-batch push instead of
 * N (the O(N²) amplification). Notifies with no current subscribers are
 * ignored without arming a timer.
 *
 * The hub is a process-wide singleton sharing the LISTEN plumbing with
 * the log stream (see pg-listen.ts): the connection starts lazily on the
 * first subscription and reconnects on failure.
 */

import { Elysia } from "elysia";
import type { ServerWebSocket } from "bun";
import {
  COMMAND_RESULT_CHANNEL,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { authenticateRequest, userCanAccessProject, UuidParam } from "./validate";
import { loadCommandBatchDetail } from "./devices";
import { createPgChannelListener, type PgListenLog } from "../pg-listen";

const WS_PROTOCOL = "soulcloud";

/** Default per-batch notification debounce window (ms). */
const DEBOUNCE_MS = 250;

/** Hub options; `debounceMs` lets tests inject a short window. */
interface CommandStreamHubOptions {
  debounceMs?: number;
}

interface CommandStreamHub {
  /** Registers a socket for a batch; starts the listener on first use. */
  subscribe(batchId: string, ws: ServerWebSocket): void;
  unsubscribe(batchId: string, ws: ServerWebSocket): void;
  /** Closes the LISTEN connection (process shutdown / tests). */
  close(): Promise<void>;
}

let hubSingleton: CommandStreamHub | null = null;

/**
 * Returns the process-wide hub. The pg LISTEN connection is created
 * lazily on the first subscribe and shared by every subscription.
 */
export function getCommandStreamHub(
  prisma: PrismaClient,
  databaseUrl: string,
  log: PgListenLog,
  options: CommandStreamHubOptions = {},
): CommandStreamHub {
  if (hubSingleton) return hubSingleton;

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Debounced push scheduling: notifies within the window for the same
   * batch reset the timer, so a burst of results merges into one
   * re-query + one push. Without subscribers the notify is ignored
   * (lossy by design; clients fall back to REST).
   */
  function schedulePush(batchId: string) {
    const sockets = subscribers.get(batchId);
    if (!sockets || sockets.size === 0) return;
    const existing = pendingTimers.get(batchId);
    if (existing) clearTimeout(existing);
    pendingTimers.set(
      batchId,
      setTimeout(() => {
        pendingTimers.delete(batchId);
        void pushBatch(prisma, subscribers, batchId, log);
      }, debounceMs),
    );
  }

  const listener = createPgChannelListener(
    databaseUrl,
    COMMAND_RESULT_CHANNEL,
    (payload) => {
      if (!payload) return;
      schedulePush(payload);
    },
    log,
  );

  hubSingleton = {
    subscribe(batchId: string, ws: ServerWebSocket) {
      let set = subscribers.get(batchId);
      if (!set) {
        set = new Set();
        subscribers.set(batchId, set);
      }
      set.add(ws);
      listener.start();
    },
    unsubscribe(batchId: string, ws: ServerWebSocket) {
      const set = subscribers.get(batchId);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) subscribers.delete(batchId);
    },
    async close() {
      // cancel pending debounce pushes so the process exits cleanly
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      await listener.close();
      subscribers.clear();
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

/**
 * Re-queries the batch (REST detail shape) and pushes it to every
 * subscriber. Failures are logged and skipped (the batch stays queryable
 * via REST).
 */
async function pushBatch(
  prisma: PrismaClient,
  subscribers: Map<string, Set<ServerWebSocket>>,
  batchId: string,
  log: PgListenLog,
): Promise<void> {
  const sockets = subscribers.get(batchId);
  if (!sockets || sockets.size === 0) return;

  let loaded: Awaited<ReturnType<typeof loadCommandBatchDetail>>;
  try {
    loaded = await loadCommandBatchDetail(prisma, batchId);
  } catch (error) {
    log.warn("command stream batch load failed", {
      error: (error as Error).message,
    });
    return;
  }
  if (!loaded) return;

  const payload = JSON.stringify({ type: "batch", ...loaded.detail });
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        // socket is closing; the close handler will unsubscribe it
      }
    }
  }
}

/** Creates the realtime command stream route (attached to the API app). */
export function createCommandStreamRoutes(
  prisma: PrismaClient,
  jwt: JwtConfig,
  options: { databaseUrl?: string; log?: PgListenLog; debounceMs?: number } = {},
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const log: PgListenLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const hub = getCommandStreamHub(prisma, databaseUrl, log, {
    debounceMs: options.debounceMs,
  });

  return new Elysia().ws("/v1/ws/commands", {
    async beforeHandle({ request, query, set }) {
      // subprotocol auth: ["soulcloud", "<access token>"]
      const protocol = request.headers.get("sec-websocket-protocol") ?? "";
      const [name, token] = protocol
        .split(",")
        .map((s) => s.trim());
      if (name !== WS_PROTOCOL || !token) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const batchId = UuidParam.safeParse(String(query.batch_id ?? ""));
      if (!batchId.success) {
        set.status = 400;
        return { error: "invalid_request", message: "batch_id must be a UUID" };
      }
      // reuse the REST auth path by projecting the subprotocol token onto
      // an Authorization header
      const authUser = await authenticateRequest(
        prisma,
        jwt,
        new Request("http://localhost", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const loaded = await loadCommandBatchDetail(prisma, batchId.data);
      if (!loaded) {
        set.status = 404;
        return { error: "not_found", message: "command batch does not exist" };
      }
      // same membership rule as the REST detail endpoint: every target
      // device's project must be accessible to the user
      for (const projectId of loaded.projects) {
        if (!(await userCanAccessProject(prisma, authUser.user.id, projectId))) {
          set.status = 404;
          return { error: "not_found", message: "command batch does not exist" };
        }
      }
    },
    open(ws) {
      // the upgrade was already authenticated in beforeHandle; the batch
      // id rides the query string (visible in ws.data.query)
      const batchId = (ws.data as { query?: { batch_id?: string } }).query?.batch_id;
      if (!batchId) {
        ws.close(4401, "unauthorized");
        return;
      }
      hub.subscribe(batchId, ws as unknown as ServerWebSocket);
      ws.send(JSON.stringify({ type: "ready", batch_id: batchId }));
    },
    message(ws, message) {
      // heartbeat / keepalive replies; the client may send plain "ping"
      // or a JSON {"type":"ping"} (Elysia JSON-parses object frames)
      const kind =
        typeof message === "string"
          ? message
          : (message as { type?: unknown } | null)?.type;
      if (kind === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    },
    close(ws) {
      const batchId = (ws.data as { query?: { batch_id?: string } }).query?.batch_id;
      if (batchId) hub.unsubscribe(batchId, ws as unknown as ServerWebSocket);
    },
  });
}
