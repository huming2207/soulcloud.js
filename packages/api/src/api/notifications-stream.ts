/**
 * Rollout lifecycle notifications for the web console.
 *
 * Endpoint: `GET /v1/ws/notifications?project_id=<uuid>` (WebSocket)
 *
 * Authentication rides the Sec-WebSocket-Protocol header (the browser
 * WebSocket API cannot set headers): `["soulcloud", "<access token>"]`.
 * The upgrade is rejected (401/404) unless the token is valid, the
 * project exists and the user is a member.
 *
 * Data path: the rollout state machine (core/src/ota/rollout.ts) issues
 * pg_notify on `soulcloud_notifications` with a JSON payload
 * `{ type, rollout_id, project_id, ts }` after each committed
 * transition (manual_approval / completed / paused / aborted / resumed).
 * The process-wide hub LISTENs the channel and fans the frame out to
 * every subscriber of that project as
 * `{ type: "notification", notification: <payload> }`.
 *
 * NOTIFY is lossy by design: a missed notification only costs
 * immediacy - the UI re-reads rollout state over REST on reload.
 */

import { Elysia } from "elysia";
import type { ServerWebSocket } from "bun";
import {
  NOTIFICATIONS_CHANNEL,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { createPgChannelListener, type PgListenLog } from "../pg-listen";
import { jwtSubject, scheduleMembershipCheck } from "./ws-access";
import { authenticateRequest, userCanAccessProject, UuidParam } from "./validate";

const WS_PROTOCOL = "soulcloud";
const EXP_CHECK_INTERVAL_MS_DEFAULT = 30_000;
const MAX_CONNECTIONS_DEFAULT = 500;

/** Hub options; tests inject a short window / cap. */
interface NotificationsHubOptions {
  maxConnections?: number;
}

interface NotificationsHub {
  /** Registers a socket for a project; starts the listener on first use. */
  subscribe(projectId: string, ws: ServerWebSocket): void;
  unsubscribe(projectId: string, ws: ServerWebSocket): void;
  /** Closes the LISTEN connection (process shutdown / tests). */
  close(): Promise<void>;
}

let hubSingleton: NotificationsHub | null = null;

/**
 * Returns the process-wide hub. The pg LISTEN connection is created
 * lazily on the first subscribe and shared by every subscription.
 */
export function getNotificationsHub(
  databaseUrl: string,
  log: PgListenLog,
  options: NotificationsHubOptions = {},
): NotificationsHub {
  if (hubSingleton) return hubSingleton;

  const maxConnections =
    options.maxConnections ??
    (Number(process.env.SOULCLOUD_WS_MAX_CONNECTIONS) || MAX_CONNECTIONS_DEFAULT);
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  let connectionCount = 0;

  const listener = createPgChannelListener(
    databaseUrl,
    NOTIFICATIONS_CHANNEL,
    (payload) => {
      if (!payload) return;
      let parsed: {
        type?: string;
        rollout_id?: string;
        project_id?: string;
      } | null = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return; // malformed payload; ignore
      }
      if (!parsed?.project_id) return;
      const sockets = subscribers.get(parsed.project_id);
      if (!sockets || sockets.size === 0) return;
      const frame = JSON.stringify({
        type: "notification",
        notification: parsed,
      });
      for (const ws of sockets) {
        if (ws.readyState === 1) {
          try {
            ws.send(frame);
          } catch {
            // closing; the close handler unsubscribes it
          }
        }
      }
    },
    log,
  );

  hubSingleton = {
    subscribe(projectId: string, ws: ServerWebSocket) {
      if (connectionCount >= maxConnections) {
        try {
          ws.close(4401, "too many connections");
        } catch {
          // already closing
        }
        return;
      }
      connectionCount += 1;
      let set = subscribers.get(projectId);
      if (!set) {
        set = new Set();
        subscribers.set(projectId, set);
      }
      set.add(ws);
      listener.start();
    },
    unsubscribe(projectId: string, ws: ServerWebSocket) {
      const set = subscribers.get(projectId);
      if (!set) return;
      const removed = set.delete(ws);
      if (removed) connectionCount = Math.max(0, connectionCount - 1);
      if (set.size === 0) subscribers.delete(projectId);
    },
    async close() {
      await listener.close();
      subscribers.clear();
      connectionCount = 0;
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

/** Creates the notifications stream route (attached to the API app). */
export function createNotificationsStreamRoutes(
  prisma: PrismaClient,
  jwt: JwtConfig,
  options: {
    databaseUrl?: string;
    log?: PgListenLog;
    maxConnections?: number;
    /** Access-token expiry check interval; tests inject a short value. */
    expCheckIntervalMs?: number;
  } = {},
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const log: PgListenLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const expCheckIntervalMs =
    options.expCheckIntervalMs ??
    (Number(process.env.SOULCLOUD_WS_EXP_CHECK_MS) || EXP_CHECK_INTERVAL_MS_DEFAULT);
  const hub = getNotificationsHub(databaseUrl, log, {
    maxConnections: options.maxConnections,
  });

  // per-connection expiry state (M2): close 4401 when the token expires
  const expiryByWs = new Map<ServerWebSocket, number>();
  const expiryTimers = new Map<ServerWebSocket, ReturnType<typeof setInterval>>();
  const accessCleanups = new WeakMap<ServerWebSocket, () => void>();

  function canonicalId(raw: string | undefined): string | null {
    if (!raw) return null;
    const parsed = UuidParam.safeParse(raw);
    // canonical lowercase key: notify payloads carry the DB-stored form,
    // so a mixed-case query value must map onto the same hub key
    return parsed.success ? parsed.data.toLowerCase() : null;
  }

  function armExpiryCheck(ws: ServerWebSocket) {
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

  return new Elysia().ws("/v1/ws/notifications", {
    async beforeHandle({ request, query, set }) {
      // subprotocol auth: ["soulcloud", "<access token>"]
      const protocol = request.headers.get("sec-websocket-protocol") ?? "";
      const [name, token] = protocol.split(",").map((s) => s.trim());
      if (name !== WS_PROTOCOL || !token) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const projectId = UuidParam.safeParse(String(query.project_id ?? ""));
      if (!projectId.success) {
        set.status = 400;
        return { error: "invalid_request", message: "project_id must be a UUID" };
      }
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
      const project = await prisma.project.findUnique({
        where: { id: projectId.data },
        select: { id: true },
      });
      if (!project) {
        set.status = 404;
        return { error: "not_found", message: "project does not exist" };
      }
      // unified 404 for non-members (no project-existence oracle)
      if (!(await userCanAccessProject(prisma, authUser.user.id, projectId.data))) {
        set.status = 404;
        return { error: "not_found", message: "project does not exist" };
      }
    },
    open(ws) {
      const projectId = canonicalId(
        (ws.data as { query?: { project_id?: string } }).query?.project_id,
      );
      if (!projectId) {
        ws.close(4401, "unauthorized");
        return;
      }
      const socket = ws as unknown as ServerWebSocket;
      hub.subscribe(projectId, socket);
      // membership re-check: a user removed from the project stops
      // receiving notifications
      const protocol = (ws.data as unknown as { headers?: Record<string, unknown> }).headers?.[
        "sec-websocket-protocol"
      ];
      const token = String(protocol ?? "")
        .split(",")
        .map((s) => s.trim())[1];
      const userId = jwtSubject(token);
      if (userId) {
        accessCleanups.set(
          socket,
          scheduleMembershipCheck(socket, prisma, userId, [projectId], expCheckIntervalMs),
        );
      }
      armExpiryCheck(socket);
      ws.send(JSON.stringify({ type: "ready", project_id: projectId }));
    },
    message(ws, message) {
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
      const stopAccess = accessCleanups.get(socket);
      if (stopAccess) {
        stopAccess();
        accessCleanups.delete(socket);
      }
      clearExpiry(socket);
      const projectId = canonicalId(
        (ws.data as { query?: { project_id?: string } }).query?.project_id,
      );
      if (projectId) hub.unsubscribe(projectId, socket);
    },
  });
}

/** Minimal unverified JWT payload decode (the handshake already verified it). */
function decodeJwt(token: string): { exp?: unknown } {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) return {};
  return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
    exp?: unknown;
  };
}
