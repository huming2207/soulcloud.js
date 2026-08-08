/**
 * Realtime log stream for the web console (proposal: log over WebSocket).
 *
 * Endpoint: `GET /v1/ws/logs?device_id=<uuid>` (WebSocket upgrade)
 *
 * Authentication rides the Sec-WebSocket-Protocol header because the
 * browser WebSocket API cannot set arbitrary headers: the client connects
 * with subprotocols `["soulcloud", "<access token>"]`. The upgrade is
 * rejected (401/404) unless the token is valid, the device exists and
 * the user is a project member. The device id itself is a non-secret
 * UUID and travels in the query string.
 *
 * Delivery model: PostgreSQL LISTEN on `soulcloud_log_events`. The
 * notify payload is "<deviceId>:<eventId>" so the hub can check its
 * subscribers BEFORE hitting the database. Events are batched per
 * device inside a debounce window (default 250ms): a burst of log
 * packets costs one batched query + one decode pass (shared
 * dictionary) instead of one full dictionary scan per packet.
 *
 * Connection lifecycle: the hub records the access-token exp at
 * handshake and closes sockets with 4401 once it passes (the client
 * hook reconnects with a fresh token), and enforces a global
 * connection cap (500).
 *
 * The hub is a process-wide singleton: the LISTEN connection starts
 * lazily on the first subscription and reconnects on failure.
 */

import { Elysia } from "elysia";
import type { ServerWebSocket } from "bun";
import {
  decodeEventsBatch,
  LOG_EVENTS_CHANNEL,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { authenticateRequest, userCanAccessProject, UuidParam } from "./validate";
import { createPgChannelListener, type PgListenLog } from "../pg-listen";
import { jwtSubject, scheduleMembershipCheck } from "./ws-access";

const WS_PROTOCOL = "soulcloud";

/** Debounce window for merging burst log notifications (ms). */
const DEBOUNCE_MS = 250;

/**
 * Hard ceiling on how long a batch may wait before being pushed, even
 * under a continuous burst (prevents starvation: without this, a steady
 * stream of notifications keeps resetting the timer forever).
 */
const MAX_WAIT_MS = DEBOUNCE_MS * 2;

/** Global cap on live log-stream sockets. */
const MAX_CONNECTIONS = 500;

/** How often to re-check the handshake token's exp (ms). */
const EXP_CHECK_INTERVAL_MS = 30_000;

interface LogStreamHubOptions {
  debounceMs?: number;
  maxConnections?: number;
  expCheckIntervalMs?: number;
}

interface LogStreamHub {
  /** Registers a socket for a device; starts the listener on first use. */
  subscribe(deviceId: string, ws: ServerWebSocket): void;
  unsubscribe(deviceId: string, ws: ServerWebSocket): void;
  /** Closes the LISTEN connection (process shutdown / tests). */
  close(): Promise<void>;
}

let hubSingleton: LogStreamHub | null = null;

/**
 * Returns the process-wide hub. The pg LISTEN connection is created
 * lazily on the first subscribe and shared by every subscription.
 */
export function getLogStreamHub(
  prisma: PrismaClient,
  databaseUrl: string,
  log: PgListenLog,
  options: LogStreamHubOptions = {},
): LogStreamHub {
  if (hubSingleton) return hubSingleton;

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  // deviceId -> event ids collected inside the debounce window
  const pendingEvents = new Map<string, string[]>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingSince = new Map<string, number>();
  let connectionCount = 0;

  /** Flushes the queued events for a device (timer edge or max-wait). */
  function flush(deviceId: string) {
    pendingTimers.delete(deviceId);
    pendingSince.delete(deviceId);
    const batch = pendingEvents.get(deviceId);
    pendingEvents.delete(deviceId);
    if (batch && batch.length > 0) {
      void pushEvents(prisma, subscribers, deviceId, batch, log);
    }
  }

  /**
   * Queues an event for a device and arms/resets the debounce window.
   * Subscribers are checked first: with nobody listening the notify is
   * dropped without touching the database (lossy by design; REST is the
   * recovery path). MAX_WAIT_MS bounds the merge window so a continuous
   * burst can never starve the push.
   */
  function schedulePush(deviceId: string, eventId: string) {
    const sockets = subscribers.get(deviceId);
    if (!sockets || sockets.size === 0) return;
    let ids = pendingEvents.get(deviceId);
    if (!ids) {
      ids = [];
      pendingEvents.set(deviceId, ids);
    }
    ids.push(eventId);

    const now = Date.now();
    const existing = pendingTimers.get(deviceId);
    if (!existing) {
      pendingSince.set(deviceId, now);
      pendingTimers.set(
        deviceId,
        setTimeout(() => flush(deviceId), debounceMs),
      );
      return;
    }
    // a burst may keep resetting the timer; once the batch has waited
    // MAX_WAIT_MS, flush it now and re-arm the window for what follows
    const waited = now - (pendingSince.get(deviceId) ?? now);
    if (waited >= MAX_WAIT_MS) {
      clearTimeout(existing);
      flush(deviceId);
      pendingSince.set(deviceId, now);
      pendingTimers.set(
        deviceId,
        setTimeout(() => flush(deviceId), debounceMs),
      );
      return;
    }
    clearTimeout(existing);
    pendingTimers.set(
      deviceId,
      setTimeout(() => flush(deviceId), debounceMs),
    );
  }

  // LISTEN plumbing (connect + reconnect) is shared with the command
  // stream via createPgChannelListener; only the subscriber map and the
  // per-notification fanout are specific to this stream.
  const listener = createPgChannelListener(
    databaseUrl,
    LOG_EVENTS_CHANNEL,
    (payload) => {
      if (!payload) return;
      // payload = "<deviceId>:<eventId>"
      const sep = payload.indexOf(":");
      if (sep <= 0) return;
      schedulePush(payload.slice(0, sep).toLowerCase(), payload.slice(sep + 1));
    },
    log,
  );

  hubSingleton = {
    subscribe(deviceId: string, ws: ServerWebSocket) {
      if (connectionCount >= maxConnections) {
        try {
          ws.close(4401, "too many connections");
        } catch {
          // already closing
        }
        return;
      }
      const key = deviceId.toLowerCase();
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(ws);
      connectionCount += 1;
      listener.start();
    },
    unsubscribe(deviceId: string, ws: ServerWebSocket) {
      const set = subscribers.get(deviceId.toLowerCase());
      if (!set) return;
      const removed = set.delete(ws);
      if (removed) connectionCount = Math.max(0, connectionCount - 1);
      if (set.size === 0) subscribers.delete(deviceId.toLowerCase());
    },
    async close() {
      await listener.close();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      pendingEvents.clear();
      pendingSince.clear();
      subscribers.clear();
      connectionCount = 0;
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

/**
 * Decodes a batch of stored log events (one shared dictionary pass) and
 * pushes each to every subscriber of the device. Failures are logged and
 * skipped per event (they stay queryable via REST).
 */
async function pushEvents(
  prisma: PrismaClient,
  subscribers: Map<string, Set<ServerWebSocket>>,
  deviceId: string,
  eventIds: string[],
  log: PgListenLog,
): Promise<void> {
  const sockets = subscribers.get(deviceId.toLowerCase());
  if (!sockets || sockets.size === 0) return;

  let rows: Awaited<ReturnType<typeof prisma.rawLogEvent.findMany>>;
  try {
    rows = await prisma.rawLogEvent.findMany({
      where: { id: { in: eventIds.map((id) => BigInt(id)) } },
    });
  } catch (error) {
    log.warn("log stream batch load failed", { error: (error as Error).message });
    return;
  }
  if (rows.length === 0) return;

  // preserve the arrival order of the notifications
  const byId = new Map(rows.map((r) => [r.id.toString(), r]));
  const ordered = eventIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  let decoded: Array<{ tag: string | null; message: string | null }> = [];
  try {
    decoded = await decodeEventsBatch(prisma, ordered);
  } catch (error) {
    log.warn("log stream decode failed", { error: (error as Error).message });
    decoded = ordered.map(() => ({ tag: null, message: null }));
  }

  const payloads = ordered.map((row, i) => {
    const event = {
      id: row.id.toString(),
      received_at: row.receivedAt,
      device_time_ms: row.deviceTimeMs.toString(),
      sequence: row.sequence,
      packet_type: row.packetType,
      level: row.level,
      tag: decoded[i]?.tag ?? null,
      message: decoded[i]?.message ?? null,
      decode_state: row.decodeState,
    };
    return JSON.stringify({ type: "log", device_id: row.deviceId, event });
  });

  for (const ws of sockets) {
    if (ws.readyState !== 1) continue;
    for (const payload of payloads) {
      try {
        ws.send(payload);
      } catch {
        // socket is closing; the close handler will unsubscribe it
        break;
      }
    }
  }
}

/** Reads the exp claim from a verified JWT (base64url; no signature check needed here). */
function jwtExp(token: string): number | undefined {
  try {
    const [, payloadPart] = token.split(".");
    if (!payloadPart) return undefined;
    const json = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Tracks per-socket exp timers so close() can clean them up. */
const expTimers = new WeakMap<ServerWebSocket, ReturnType<typeof setInterval>>();
/** Tracks per-socket membership re-check stops (close handler cleans up). */
const accessCleanups = new WeakMap<ServerWebSocket, () => void>();

/** Creates the realtime log stream route (attached to the API app). */
export function createLogStreamRoutes(
  prisma: PrismaClient,
  jwt: JwtConfig,
  options: {
    databaseUrl: string;
    log?: PgListenLog;
    debounceMs?: number;
    maxConnections?: number;
    expCheckIntervalMs?: number;
  } = {
    databaseUrl: process.env.DATABASE_URL ?? "",
  },
) {
  const log: PgListenLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const hub = getLogStreamHub(prisma, options.databaseUrl, log, {
    debounceMs: options.debounceMs,
    maxConnections: options.maxConnections,
  });
  const expCheckIntervalMs = options.expCheckIntervalMs ?? EXP_CHECK_INTERVAL_MS;

  return new Elysia().ws("/v1/ws/logs", {
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
      const deviceId = UuidParam.safeParse(String(query.device_id ?? ""));
      if (!deviceId.success) {
        set.status = 400;
        return { error: "invalid_request", message: "device_id must be a UUID" };
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
      const device = await prisma.device.findUnique({
        where: { id: deviceId.data },
        select: { projectId: true },
      });
      if (!device) {
        set.status = 404;
        return { error: "not_found", message: "device does not exist" };
      }
      if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
        set.status = 404;
        return { error: "not_found", message: "device does not exist" };
      }
    },
    open(ws) {
      // the upgrade was already authenticated in beforeHandle; the device
      // id rides the query string (visible in ws.data.query) and the
      // handshake headers (with the subprotocol token) are visible too
      const data = ws.data as {
        query?: { device_id?: string };
        headers?: Record<string, string>;
      };
      const deviceId = data.query?.device_id;
      if (!deviceId) {
        ws.close(4401, "unauthorized");
        return;
      }
      const socket = ws as unknown as ServerWebSocket;
      hub.subscribe(deviceId, socket);
      // membership re-check (Kimi round-8 low): a user removed from the
      // project must stop receiving frames even on an established socket
      const protocol = data.headers?.["sec-websocket-protocol"] ?? "";
      const [, token] = protocol.split(",").map((s) => s.trim());
      const userId = jwtSubject(token);
      if (userId) {
        void prisma.device
          .findUnique({ where: { id: deviceId }, select: { projectId: true } })
          .then((device) => {
            if (!device) return;
            accessCleanups.set(
              socket,
              scheduleMembershipCheck(socket, prisma, userId, [device.projectId], expCheckIntervalMs),
            );
          });
      }
      // M2: close once the handshake token expired (the client hook
      // reconnects with a fresh token, so this self-heals)
      const exp = token ? jwtExp(token) : undefined;
      if (typeof exp === "number" && Number.isFinite(exp)) {
        const check = () => {
          if (Date.now() >= exp * 1000) {
            try {
              socket.close(4401, "token expired");
            } catch {
              // already closed
            }
            return true;
          }
          return false;
        };
        if (!check()) {
          const timer = setInterval(() => {
            if (check()) clearInterval(timer);
          }, expCheckIntervalMs);
          expTimers.set(socket, timer);
        }
      }
      ws.send(JSON.stringify({ type: "ready", device_id: deviceId }));
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
      const socket = ws as unknown as ServerWebSocket;
      const stop = accessCleanups.get(socket);
      if (stop) {
        stop();
        accessCleanups.delete(socket);
      }
      const timer = expTimers.get(socket);
      if (timer) {
        clearInterval(timer);
        expTimers.delete(socket);
      }
      const deviceId = (ws.data as { query?: { device_id?: string } }).query?.device_id;
      if (deviceId) hub.unsubscribe(deviceId, socket);
    },
  });
}
