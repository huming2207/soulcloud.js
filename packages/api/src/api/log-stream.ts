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
 * Delivery model: PostgreSQL LISTEN on `soulcloud_log_events` (payload =
 * raw_log_events row id). Each notification is decoded server-side
 * (same decode path as the REST API) and pushed as
 * `{ type: "log", event: <REST event shape> }`. NOTIFY is lossy: a
 * missed notification costs latency only — clients fall back to the
 * REST paging endpoint.
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

const WS_PROTOCOL = "soulcloud";

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
): LogStreamHub {
  if (hubSingleton) return hubSingleton;

  const subscribers = new Map<string, Set<ServerWebSocket>>();
  // LISTEN plumbing (connect + reconnect) is shared with the command
  // stream via createPgChannelListener; only the subscriber map and the
  // per-notification fanout are specific to this stream.
  const listener = createPgChannelListener(
    databaseUrl,
    LOG_EVENTS_CHANNEL,
    (payload) => {
      if (!payload) return;
      void pushEvent(prisma, subscribers, payload, log);
    },
    log,
  );

  hubSingleton = {
    subscribe(deviceId: string, ws: ServerWebSocket) {
      let set = subscribers.get(deviceId);
      if (!set) {
        set = new Set();
        subscribers.set(deviceId, set);
      }
      set.add(ws);
      listener.start();
    },
    unsubscribe(deviceId: string, ws: ServerWebSocket) {
      const set = subscribers.get(deviceId);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) subscribers.delete(deviceId);
    },
    async close() {
      await listener.close();
      subscribers.clear();
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

/**
 * Decodes a stored log event and pushes it to every subscriber of its
 * device. Failures are logged and skipped (the event stays queryable via
 * REST).
 */
async function pushEvent(
  prisma: PrismaClient,
  subscribers: Map<string, Set<ServerWebSocket>>,
  eventId: string,
  log: PgListenLog,
): Promise<void> {
  let row: Awaited<ReturnType<typeof prisma.rawLogEvent.findUnique>>;
  try {
    row = await prisma.rawLogEvent.findUnique({
      where: { id: BigInt(eventId) },
    });
  } catch {
    return;
  }
  if (!row) return;

  const sockets = subscribers.get(row.deviceId);
  if (!sockets || sockets.size === 0) return;

  let decoded: { tag: string | null; message: string | null } | null = null;
  try {
    const [d] = await decodeEventsBatch(prisma, [row]);
    decoded = d ?? null;
  } catch (error) {
    log.warn("log stream decode failed", { error: (error as Error).message });
  }

  const event = {
    id: row.id.toString(),
    received_at: row.receivedAt,
    device_time_ms: row.deviceTimeMs.toString(),
    sequence: row.sequence,
    packet_type: row.packetType,
    level: row.level,
    tag: decoded?.tag ?? null,
    message: decoded?.message ?? null,
    decode_state: row.decodeState,
  };
  const payload = JSON.stringify({ type: "log", device_id: row.deviceId, event });
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

/** Creates the realtime log stream route (attached to the API app). */
export function createLogStreamRoutes(
  prisma: PrismaClient,
  jwt: JwtConfig,
  options: { databaseUrl: string; log?: PgListenLog } = {
    databaseUrl: process.env.DATABASE_URL ?? "",
  },
) {
  const log: PgListenLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const hub = getLogStreamHub(prisma, options.databaseUrl, log);

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
      // id rides the query string (visible in ws.data.query)
      const deviceId = (ws.data as { query?: { device_id?: string } }).query?.device_id;
      if (!deviceId) {
        ws.close(4401, "unauthorized");
        return;
      }
      hub.subscribe(deviceId, ws as unknown as ServerWebSocket);
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
      const deviceId = (ws.data as { query?: { device_id?: string } }).query?.device_id;
      if (deviceId) hub.unsubscribe(deviceId, ws as unknown as ServerWebSocket);
    },
  });
}
