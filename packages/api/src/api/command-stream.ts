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
import { decodeJwt } from "jose";
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

/**
 * Maximum time a burst of notifies for one batch may defer its push
 * (trailing edge); a sustained burst still pushes at least this often.
 */
const MAX_WAIT_FACTOR = 4;

/** Default interval for checking access-token expiry (M2). */
const EXP_CHECK_INTERVAL_MS_DEFAULT = 30_000;

/** Default per-process WebSocket connection cap (M3). */
const MAX_CONNECTIONS_DEFAULT = 500;

/** Hub options; `debounceMs` lets tests inject a short window. */
interface CommandStreamHubOptions {
  debounceMs?: number;
  maxConnections?: number;
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
  const maxWaitMs = debounceMs * MAX_WAIT_FACTOR;
  const maxConnections =
    options.maxConnections ??
    (Number(process.env.SOULCLOUD_WS_MAX_CONNECTIONS) || MAX_CONNECTIONS_DEFAULT);
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // first-notify timestamp per batch, for the max-wait bound
  const firstNotifyAt = new Map<string, number>();
  let connectionCount = 0;

  /**
   * Debounced push scheduling: notifies within the window for the same
   * batch reset the timer, so a burst of results merges into one
   * re-query + one push. A sustained burst is bounded by maxWaitMs (the
   * push fires no later than that from the first notify of the burst).
   * Without subscribers the notify is ignored (lossy by design; clients
   * fall back to REST).
   */
  function schedulePush(batchId: string) {
    const sockets = subscribers.get(batchId);
    if (!sockets || sockets.size === 0) return;
    const now = Date.now();
    const first = firstNotifyAt.get(batchId) ?? now;
    firstNotifyAt.set(batchId, first);
    const existing = pendingTimers.get(batchId);
    if (existing) clearTimeout(existing);
    // trailing edge: debounceMs after the last notify, but never later
    // than maxWaitMs after the first notify of the burst
    const elapsed = now - first;
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - elapsed));
    pendingTimers.set(
      batchId,
      setTimeout(() => {
        pendingTimers.delete(batchId);
        firstNotifyAt.delete(batchId);
        void pushBatch(prisma, subscribers, batchId, log);
      }, delay),
    );
  }

  const listener = createPgChannelListener(
    databaseUrl,
    COMMAND_RESULT_CHANNEL,
    (payload) => {
      if (!payload) return;
      schedulePush(payload.toLowerCase());
    },
    log,
  );

  hubSingleton = {
    subscribe(batchId: string, ws: ServerWebSocket) {
      // M3: per-process connection cap (one token may open unlimited
      // sockets otherwise)
      if (connectionCount >= maxConnections) {
        try {
          ws.close(4401, "too many connections");
        } catch {
          // socket is already closing; nothing to do
        }
        return;
      }
      connectionCount += 1;
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
      connectionCount = Math.max(0, connectionCount - 1);
      if (set.size === 0) subscribers.delete(batchId);
    },
    async close() {
      // cancel pending debounce pushes so the process exits cleanly
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      firstNotifyAt.clear();
      await listener.close();
      subscribers.clear();
      connectionCount = 0;
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
  options: {
    databaseUrl?: string;
    log?: PgListenLog;
    debounceMs?: number;
    maxConnections?: number;
    /** Access-token expiry check interval; tests inject a short value via env. */
    expCheckIntervalMs?: number;
  } = {},
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const log: PgListenLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const expCheckIntervalMs =
    options.expCheckIntervalMs ??
    (Number(process.env.SOULCLOUD_WS_EXP_CHECK_MS) || EXP_CHECK_INTERVAL_MS_DEFAULT);
  const hub = getCommandStreamHub(prisma, databaseUrl, log, {
    debounceMs: options.debounceMs,
    maxConnections: options.maxConnections,
  });

  // per-connection expiry state (M2): the access token is verified at
  // handshake, but the connection outlives it; close 4401 when the token
  // expires so the client hook reconnects with a fresh token
  const expiryByWs = new Map<ServerWebSocket, number>();
  const expiryTimers = new Map<ServerWebSocket, ReturnType<typeof setInterval>>();

  function canonicalId(raw: string | undefined): string | null {
    if (!raw) return null;
    const parsed = UuidParam.safeParse(raw);
    // canonical lowercase key: notify payloads carry the DB-stored form,
    // so a mixed-case query value must map onto the same hub key
    return parsed.success ? parsed.data.toLowerCase() : null;
  }

  function armExpiryCheck(ws: ServerWebSocket) {
    // the token rode the subprotocol header; decode its exp (the signature
    // was already verified in beforeHandle, so this is trustworthy)
    const protocol = (ws.data as unknown as { headers?: Record<string, unknown> }).headers?.[
      "sec-websocket-protocol"
    ];
    const token = String(protocol ?? "")
      .split(",")
      .map((s) => s.trim())[1];
    let expMs = 0;
    if (token) {
      try {
        const { exp } = decodeJwt(token);
        if (typeof exp === "number") expMs = exp * 1000;
      } catch {
        // unparsable; the handshake already rejected invalid tokens
      }
    }
    if (expMs === 0) return;
    expiryByWs.set(ws, expMs);
    const timer = setInterval(() => {
      const deadline = expiryByWs.get(ws);
      if (deadline !== undefined && Date.now() >= deadline) {
        expiryByWs.delete(ws);
        clearInterval(timer);
        expiryTimers.delete(ws);
        ws.close(4401, "token expired");
      }
    }, expCheckIntervalMs);
    expiryTimers.set(ws, timer);
  }

  function clearExpiry(ws: ServerWebSocket) {
    const timer = expiryTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      expiryTimers.delete(ws);
    }
    expiryByWs.delete(ws);
  }

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
      const batchId = canonicalId(
        (ws.data as { query?: { batch_id?: string } }).query?.batch_id,
      );
      if (!batchId) {
        ws.close(4401, "unauthorized");
        return;
      }
      hub.subscribe(batchId, ws as unknown as ServerWebSocket);
      armExpiryCheck(ws as unknown as ServerWebSocket);
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
      const batchId = canonicalId(
        (ws.data as { query?: { batch_id?: string } }).query?.batch_id,
      );
      if (batchId) hub.unsubscribe(batchId, ws as unknown as ServerWebSocket);
      clearExpiry(ws as unknown as ServerWebSocket);
    },
  });
}
