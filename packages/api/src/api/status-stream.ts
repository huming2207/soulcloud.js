/**
 * Realtime device online/offline stream for the web console.
 *
 * Endpoint: `GET /v1/ws/status?project_id=<uuid>` (WebSocket upgrade)
 *
 * Authentication rides the Sec-WebSocket-Protocol header (same scheme
 * as the log/command/ota streams): `["soulcloud", "<access token>"]`.
 * The upgrade is rejected (401/404) unless the token is valid and the
 * user is a project member.
 *
 * Delivery model: the broker pg_notify()s `soulcloud_device_status`
 * with `{"online": boolean, "uid": string}` on aedes client /
 * clientDisconnect. The hub resolves the uid -> projectId once per
 * notify (only when subscribers exist), maintains a process-local
 * known-state map, and pushes `{type:"status", device_uid, online, ts}`
 * to every subscriber of that project. New subscribers first receive
 * the current known state for every online device of their project.
 *
 * Per-device debounce: repeated transitions for the same uid inside the
 * window (reconnect storms) merge into the latest state.
 *
 * Connection lifecycle mirrors the other streams: token-expiry close
 * (4401), membership re-check (4403), global connection cap.
 */

import { Elysia } from "elysia";
import type { ServerWebSocket } from "bun";
import {
  DEVICE_STATUS_CHANNEL,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { authenticateRequest, userCanAccessProject, UuidParam } from "./validate";
import { createPgChannelListener, type PgListenLog } from "../pg-listen";
import { jwtSubject, scheduleMembershipCheck } from "./ws-access";

const WS_PROTOCOL = "soulcloud";

/** Per-device status debounce window (ms): merges reconnect storms. */
const DEBOUNCE_MS = 250;
/** Bounds a sustained per-device burst (prevents starvation). */
const MAX_WAIT_MS = DEBOUNCE_MS * 2;
/** Global cap on live status-stream sockets. */
const MAX_CONNECTIONS = 500;
/** How often to re-check the handshake token's exp (ms). */
const EXP_CHECK_INTERVAL_MS = 30_000;

interface StatusStreamHubOptions {
  debounceMs?: number;
  maxConnections?: number;
  expCheckIntervalMs?: number;
}

interface KnownStatus {
  online: boolean;
  ts: number;
  projectId: string;
  /** Status entries older than this are treated as unknown (the broker's
   *  in-memory session state is lost on restart, so a stale "online" must
   *  not outlive the process that produced it). */
  expiresAt: number;
}

/** How long a known status is trusted before it is treated as unknown. */
const KNOWN_TTL_MS = 5 * 60_000;

interface StatusStreamHub {
  subscribe(projectId: string, ws: ServerWebSocket): void;
  unsubscribe(projectId: string, ws: ServerWebSocket): void;
  close(): Promise<void>;
}

let hubSingleton: StatusStreamHub | null = null;

/**
 * Returns the process-wide hub. The pg LISTEN connection starts lazily
 * on the first subscribe and reconnects on failure.
 */
export function getStatusStreamHub(
  prisma: PrismaClient,
  databaseUrl: string,
  log: PgListenLog,
  options: StatusStreamHubOptions = {},
): StatusStreamHub {
  if (hubSingleton) return hubSingleton;

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = options.debounceMs ? options.debounceMs * 2 : MAX_WAIT_MS;
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  // deviceUid -> latest known status (process-local, best-effort)
  const known = new Map<string, KnownStatus>();
  // per-device debounce: pendingUids[uid] = last scheduled online state
  const pending = new Map<string, { online: boolean; since: number }>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let connectionCount = 0;

  /** Pushes the resolved status for a uid to every subscriber. */
  async function resolveAndPush(uid: string, online: boolean): Promise<void> {
    let device: { projectId: string } | null = null;
    try {
      device = await prisma.device.findUnique({
        where: { deviceUid: uid },
        select: { projectId: true },
      });
    } catch {
      return; // DB hiccup: keep the connection, drop the event
    }
    if (!device) return; // unknown device: nothing to fan out

    const ts = Date.now();
    // record even with no subscribers: the offline/online transition must
    // not be lost (it is the only signal that a device went away)
    known.set(uid, { online, ts, projectId: device.projectId, expiresAt: ts + KNOWN_TTL_MS });
    if (connectionCount === 0) return; // no subscribers: skip the fan-out
    const payload = JSON.stringify({
      type: "status",
      device_uid: uid,
      online,
      ts,
    });
    const set = subscribers.get(device.projectId);
    if (!set) return;
    for (const ws of set) {
      if (ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch {
          // socket is closing; the close handler unsubscribes it
        }
      }
    }
  }

  /** Debounced schedule per uid (merges same-device transitions). */
  function scheduleResolve(uid: string, online: boolean): void {
    const now = Date.now();
    const existing = pending.get(uid);
    const timer = pendingTimers.get(uid);
    if (existing) {
      // same device: merge into the latest state, keep the original
      // window but bound it with max-wait
      pending.set(uid, { online, since: existing.since });
      if (timer && now - existing.since >= maxWaitMs) {
        clearTimeout(timer);
        pendingTimers.delete(uid);
        pending.delete(uid);
        void resolveAndPush(uid, online);
      }
      return;
    }
    pending.set(uid, { online, since: now });
    pendingTimers.set(
      uid,
      setTimeout(() => {
        pendingTimers.delete(uid);
        const entry = pending.get(uid);
        pending.delete(uid);
        if (entry) void resolveAndPush(uid, entry.online);
      }, debounceMs),
    );
  }

  const listener = createPgChannelListener(
    databaseUrl,
    DEVICE_STATUS_CHANNEL,
    (payload) => {
      if (!payload) return;
      let parsed: { online?: unknown; uid?: unknown };
      try {
        parsed = JSON.parse(payload) as { online?: unknown; uid?: unknown };
      } catch {
        return;
      }
      if (typeof parsed.uid !== "string" || typeof parsed.online !== "boolean") return;
      scheduleResolve(parsed.uid, parsed.online);
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
      const key = projectId.toLowerCase();
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(ws);
      listener.start();
      // initial state: replay the known status for this project's devices
      // (entries past their TTL are treated as unknown and skipped)
      const now = Date.now();
      for (const [uid, status] of known) {
        if (status.projectId !== key) continue;
        if (status.expiresAt < now) continue;
        if (ws.readyState !== 1) break;
        try {
          ws.send(
            JSON.stringify({
              type: "status",
              device_uid: uid,
              online: status.online,
              ts: status.ts,
            }),
          );
        } catch {
          break;
        }
      }
    },
    unsubscribe(projectId: string, ws: ServerWebSocket) {
      const set = subscribers.get(projectId.toLowerCase());
      if (!set) return;
      const removed = set.delete(ws);
      if (removed) connectionCount = Math.max(0, connectionCount - 1);
      if (set.size === 0) subscribers.delete(projectId.toLowerCase());
    },
    async close() {
      await listener.close();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      pending.clear();
      known.clear();
      subscribers.clear();
      connectionCount = 0;
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

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

const expTimers = new WeakMap<ServerWebSocket, ReturnType<typeof setInterval>>();
const accessCleanups = new WeakMap<ServerWebSocket, () => void>();

/** Creates the realtime device-status route (attached to the API app). */
export function createStatusStreamRoutes(
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
  const log: PgListenLog = options.log ?? {
    warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? ""),
  };
  const hub = getStatusStreamHub(prisma, options.databaseUrl, log, {
    debounceMs: options.debounceMs,
    maxConnections: options.maxConnections,
    expCheckIntervalMs: options.expCheckIntervalMs,
  });
  const expCheckIntervalMs = options.expCheckIntervalMs ?? EXP_CHECK_INTERVAL_MS;

  return new Elysia().ws("/v1/ws/status", {
    async beforeHandle({ request, query, set }) {
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
      if (!(await userCanAccessProject(prisma, authUser.user.id, projectId.data))) {
        set.status = 404;
        return { error: "not_found", message: "project does not exist" };
      }
    },
    open(ws) {
      const data = ws.data as {
        query?: { project_id?: string };
        headers?: Record<string, string>;
      };
      const projectId = data.query?.project_id;
      if (!projectId) {
        ws.close(4401, "unauthorized");
        return;
      }
      const socket = ws as unknown as ServerWebSocket;
      hub.subscribe(projectId, socket);

      const protocol = data.headers?.["sec-websocket-protocol"] ?? "";
      const [, token] = protocol.split(",").map((s) => s.trim());
      const userId = jwtSubject(token);
      if (userId) {
        accessCleanups.set(
          socket,
          scheduleMembershipCheck(socket, prisma, userId, [projectId], expCheckIntervalMs),
        );
      }
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
      const projectId = (ws.data as { query?: { project_id?: string } }).query?.project_id;
      if (projectId) hub.unsubscribe(projectId, socket);
    },
  });
}
