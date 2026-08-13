/**
 * Realtime OTA job progress stream for the web console.
 *
 * Endpoint: `GET /v1/ws/ota?job_id=<uuid>` (WebSocket upgrade)
 *
 * Authentication rides the Sec-WebSocket-Protocol header because the
 * browser WebSocket API cannot set arbitrary headers: the client connects
 * with subprotocols `["soulcloud", "<access token>"]`. The upgrade is
 * rejected (401/404) unless the token is valid, the job exists and the
 * user is a member of the job's project. The job id itself is a
 * non-secret UUID and travels in the query string.
 *
 * Delivery model: PostgreSQL LISTEN on `soulcloud_ota` (payload = the
 * ota_jobs row id). Each notification is re-read server-side (same query
 * and response shape as REST GET /v1/ota-jobs/:id) and pushed as
 * `{ type: "ota", job_id, state, targets: [...], summary }`. NOTIFY is
 * lossy: a missed notification costs latency only — clients fall back to
 * the REST polling endpoint.
 *
 * Burst notifications for the same job are debounced: a notify arms a
 * per-job timer (DEBOUNCE_MS, default 250ms, configurable via hub
 * options) and further notifies within the window reset it, so N target
 * updates that land together cost one re-read + one full push instead of
 * N (the O(N²) amplification). Notifies with no current subscribers are
 * ignored without arming a timer.
 *
 * The hub is a process-wide singleton: the LISTEN connection starts
 * lazily on the first subscription and reconnects on failure. This is an
 * independent implementation of the same pattern as log-stream.ts (the
 * LISTEN/notify plumbing is duplicated on purpose until the hubs are
 * unified; log-stream.ts and command-stream.ts are owned by other work).
 */

import { Elysia } from "elysia";
import type { ServerWebSocket } from "bun";
import { createDecoder } from "fast-jwt";
import { OTA_NOTIFY_CHANNEL, type JwtConfig, type PrismaClient } from "@soulcloud/core";
import { createPgChannelListener } from "../pg-listen";
import { jwtSubject, rawSocket, scheduleMembershipCheck } from "./ws-access";
import { authenticateRequest, userCanAccessProject, UuidParam } from "./validate";
import { createTtlCache } from "./ttl-cache";

const WS_PROTOCOL = "soulcloud";

/** Module-level payload decoder (no signature check; the handshake already verified). */
const decodeTokenPayload = createDecoder();

/** jobId -> project id, resolved during the handshake (a job's project
 *  never changes). Avoids a re-query per WS connection for the
 *  membership re-check; entries expire so a long-lived process does not
 *  accumulate every job it ever saw. */
const jobProjectCache = createTtlCache<string>(10 * 60_000, 1000);

/** Default per-job notification debounce window (ms). */
const DEBOUNCE_MS = 250;

/** Maximum time a burst of notifies for one job may defer its push. */
const MAX_WAIT_FACTOR = 4;

/** Default interval for checking access-token expiry (M2). */
const EXP_CHECK_INTERVAL_MS_DEFAULT = 30_000;

/** Default per-process WebSocket connection cap (M3). */
const MAX_CONNECTIONS_DEFAULT = 500;

/** Hub options; `debounceMs` lets tests inject a short window. */
interface OtaStreamHubOptions {
  debounceMs?: number;
  maxConnections?: number;
}

interface OtaStreamHub {
  /** Registers a socket for a job; starts the listener on first use. */
  subscribe(jobId: string, ws: ServerWebSocket): void;
  unsubscribe(jobId: string, ws: ServerWebSocket): void;
  /** Closes the LISTEN connection (process shutdown / tests). */
  close(): Promise<void>;
}

interface HubLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

let hubSingleton: OtaStreamHub | null = null;

/**
 * Returns the process-wide hub. The pg LISTEN connection is created
 * lazily on the first subscribe and shared by every subscription.
 */
export function getOtaStreamHub(
  prisma: PrismaClient,
  databaseUrl: string,
  log: HubLog,
  options: OtaStreamHubOptions = {},
): OtaStreamHub {
  if (hubSingleton) return hubSingleton;

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = debounceMs * MAX_WAIT_FACTOR;
  const maxConnections =
    options.maxConnections ??
    (Number(process.env.SOULCLOUD_WS_MAX_CONNECTIONS) || MAX_CONNECTIONS_DEFAULT);
  const subscribers = new Map<string, Set<ServerWebSocket>>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const firstNotifyAt = new Map<string, number>();
  // Serialize full target-list snapshots per job. A new notify while a
  // query is in flight requests exactly one follow-up snapshot.
  const pushing = new Set<string>();
  const pushAgain = new Set<string>();
  // Delta push state: per job, the last known fingerprint of each target
  // (state|result|firmware). A push only carries the targets whose
  // fingerprint changed since the last push - the first push for a job
  // carries everything. Dropped when the last subscriber leaves so a
  // re-subscribe always gets a fresh full picture.
  const lastTargets = new Map<string, Map<string, string>>();
  // Jobs whose NEXT push must be a full snapshot: set when a NEW
  // subscriber joins. Without it, a subscriber that joined while the old
  // socket's close was still in flight (the close handler deletes the
  // delta baseline) would receive a delta against a stale baseline -
  // often EMPTY (nothing changed) - and never learn the current state.
  const fullNext = new Set<string>();
  let connectionCount = 0;
  let closed = false;

  /**
   * Debounced push scheduling: notifies within the window for the same
   * job reset the timer, so a burst of target updates merges into one
   * re-read + one push. A sustained burst is bounded by maxWaitMs (the
   * push fires no later than that from the first notify of the burst).
   * Without subscribers the notify is ignored (lossy by design; clients
   * fall back to REST).
   */
  function schedulePush(jobId: string) {
    const sockets = subscribers.get(jobId);
    if (!sockets || sockets.size === 0) return;
    const now = Date.now();
    const first = firstNotifyAt.get(jobId) ?? now;
    firstNotifyAt.set(jobId, first);
    const existing = pendingTimers.get(jobId);
    if (existing) clearTimeout(existing);
    const elapsed = now - first;
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - elapsed));
    pendingTimers.set(
      jobId,
      setTimeout(() => {
        pendingTimers.delete(jobId);
        firstNotifyAt.delete(jobId);
        flushJob(jobId);
      }, delay),
    );
  }

  /** Serializes delta pushes for one OTA job. */
  function flushJob(jobId: string): void {
    if (closed) return;
    if (pushing.has(jobId)) {
      pushAgain.add(jobId);
      return;
    }
    pushing.add(jobId);
    void pushJobUpdate(prisma, subscribers, jobId, lastTargets, fullNext, log).finally(() => {
      pushing.delete(jobId);
      if (!closed && pushAgain.delete(jobId)) schedulePush(jobId);
    });
  }

  // LISTEN plumbing is shared with the log/command streams
  const listener = createPgChannelListener(
    databaseUrl,
    OTA_NOTIFY_CHANNEL,
    (payload) => {
      if (!payload) return;
      schedulePush(payload.toLowerCase());
    },
    log,
  );

  hubSingleton = {
    subscribe(jobId: string, ws: ServerWebSocket) {
      // M3: per-process connection cap
      if (connectionCount >= maxConnections) {
        try {
          ws.close(4401, "too many connections");
        } catch {
          // socket is already closing; nothing to do
        }
        return;
      }
      connectionCount += 1;
      let set = subscribers.get(jobId);
      if (!set) {
        set = new Set();
        subscribers.set(jobId, set);
      }
      set.add(ws);
      // a fresh subscriber needs the current state, not a delta against
      // whatever baseline the previous subscriber left behind
      fullNext.add(jobId);
      listener.start();
    },
    unsubscribe(jobId: string, ws: ServerWebSocket) {
      const set = subscribers.get(jobId);
      if (!set) return;
      // see command-stream: only count actual removals (a socket refused
      // by the connection cap was never added)
      const removed = set.delete(ws);
      if (removed) connectionCount = Math.max(0, connectionCount - 1);
      if (set.size === 0) {
        subscribers.delete(jobId);
        // drop the delta baseline so a later re-subscribe gets a full
        // picture (the REST fetch already refreshed the client anyway)
        lastTargets.delete(jobId);
      }
    },
    async close() {
      closed = true;
      // cancel pending debounce pushes so the process exits cleanly
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      firstNotifyAt.clear();
      pushing.clear();
      pushAgain.clear();
      lastTargets.clear();
      connectionCount = 0;
      await listener.close();
      subscribers.clear();
      hubSingleton = null;
    },
  };
  return hubSingleton;
}

const TERMINAL_TARGET_STATES = new Set(["completed", "failed", "expired"]);

/**
 * Derives a job-level state from the target states (there is no job
 * state column; the REST detail exposes per-state counts instead):
 *   - "failed"   — at least one target failed or expired
 *   - "completed" — every target is terminal (completed/failed/expired)
 *   - "running"  — otherwise (some target still in flight)
 */
function deriveJobState(targets: Array<{ state: string }>): string {
  if (targets.some((t) => t.state === "failed" || t.state === "expired")) {
    return "failed";
  }
  if (targets.every((t) => TERMINAL_TARGET_STATES.has(t.state))) return "completed";
  return "running";
}

/**
 * Re-reads a job with its targets (same query + response shape as the
 * REST GET /v1/ota-jobs/:id handler in firmware.ts) and pushes the
 * update to every subscriber of the job. Failures are logged and
 * skipped (the job stays queryable via REST).
 */

/** The job + targets row (select-projected) backing a push. */
function fetchOtaJobWithTargets(prisma: PrismaClient, jobId: string) {
  return prisma.otaJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      releaseId: true,
      createdAt: true,
      targets: {
        select: {
          id: true,
          deviceId: true,
          device: {
            select: { deviceUid: true, firmwareState: { select: { fwHash: true } } },
          },
          state: true,
          deliveredAt: true,
          confirmedAt: true,
          resultCode: true,
          resultMessage: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

/** Stable fingerprint of one target row (state + result + firmware). */
function targetFingerprint(t: {
  state: string;
  resultCode: number | null;
  device: { firmwareState: { fwHash: string } | null };
}): string {
  return `${t.state}|${t.resultCode ?? ""}|${t.device.firmwareState?.fwHash ?? ""}`;
}

/**
 * Re-reads the job and pushes a DELTA frame: only the targets whose
 * fingerprint changed since the previous push (the first push for a job
 * carries everything). No changes -> no frame. The client merges the
 * targets into its cached detail (summary/state are always complete).
 */
async function pushJobUpdate(
  prisma: PrismaClient,
  subscribers: Map<string, Set<ServerWebSocket>>,
  jobId: string,
  lastTargets: Map<string, Map<string, string>>,
  fullNext: Set<string>,
  log: HubLog,
): Promise<void> {
  if (!subscribers.get(jobId)?.size) return;

  let job: Awaited<ReturnType<typeof fetchOtaJobWithTargets>>;
  try {
    job = await fetchOtaJobWithTargets(prisma, jobId);
  } catch (error) {
    log.warn("ota stream job lookup failed", { error: (error as Error).message });
    return;
  }
  if (!job) return;

  const forceFull = fullNext.has(jobId);
  fullNext.delete(jobId);
  const previous = forceFull ? undefined : lastTargets.get(jobId);
  const changed = previous
    ? job.targets.filter(
        (t) => previous.get(t.deviceId) !== targetFingerprint(t),
      )
    : job.targets;
  if (changed.length === 0) return; // nothing new since the last push
  const next = previous ?? new Map<string, string>();
  for (const t of job.targets) next.set(t.deviceId, targetFingerprint(t));
  lastTargets.set(jobId, next);

  // The original subscribers may have closed while the target list was
  // loading. Re-read the set so a closed hub never sends a stale frame.
  const sockets = subscribers.get(jobId);
  if (!sockets || sockets.size === 0) return;
  const summary: Record<string, number> = {};
  for (const t of job.targets) {
    summary[t.state] = (summary[t.state] ?? 0) + 1;
  }
  const payload = JSON.stringify({
    type: "ota",
    job_id: job.id,
    release_id: job.releaseId,
    created_at: job.createdAt,
    state: deriveJobState(job.targets),
    // DELTA: only the changed targets; the client merges by device_id
    targets: changed.map((t) => ({
      device_id: t.deviceId,
      device_uid: t.device.deviceUid,
      state: t.state,
      delivered_at: t.deliveredAt,
      confirmed_at: t.confirmedAt,
      result_code: t.resultCode,
      result_message: t.resultMessage,
      current_fw: t.device.firmwareState?.fwHash ?? null,
    })),
    summary,
  });
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

/** Creates the realtime OTA job stream route (attached to the API app). */
export function createOtaStreamRoutes(
  prisma: PrismaClient,
  jwt: JwtConfig,
  options: {
    databaseUrl?: string;
    log?: HubLog;
    debounceMs?: number;
    maxConnections?: number;
    /** Access-token expiry check interval; tests inject a short value via env. */
    expCheckIntervalMs?: number;
  } = {},
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const log: HubLog = options.log ?? { warn: (m, f) => console.warn(`[soulcloud-api] ${m}`, f ?? "") };
  const expCheckIntervalMs =
    options.expCheckIntervalMs ??
    (Number(process.env.SOULCLOUD_WS_EXP_CHECK_MS) || EXP_CHECK_INTERVAL_MS_DEFAULT);
  const hub = getOtaStreamHub(prisma, databaseUrl, log, {
    debounceMs: options.debounceMs,
    maxConnections: options.maxConnections,
  });

  // per-connection expiry state (M2): close 4401 when the access token
  // expires so the client hook reconnects with a fresh token
  const expiryByWs = new Map<ServerWebSocket, number>();
  const expiryTimers = new Map<ServerWebSocket, ReturnType<typeof setInterval>>();
  const accessCleanups = new WeakMap<ServerWebSocket, () => void>();

  function canonicalId(raw: string | undefined): string | null {
    if (!raw) return null;
    const parsed = UuidParam.safeParse(raw);
    // canonical lowercase key: notify payloads carry the DB-stored form
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
        const { exp } = decodeTokenPayload(token) as { exp?: unknown };
        if (typeof exp === "number") expMs = exp * 1000;
      } catch {
        // handshake already rejected invalid tokens
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

  return new Elysia().ws("/v1/ws/ota", {
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
      const jobId = UuidParam.safeParse(String(query.job_id ?? ""));
      if (!jobId.success) {
        set.status = 400;
        return { error: "invalid_request", message: "job_id must be a UUID" };
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
      const job = await prisma.otaJob.findUnique({
        where: { id: jobId.data },
        select: { projectId: true },
      });
      if (job) jobProjectCache.set(jobId.data, job.projectId);
      if (!job) {
        set.status = 404;
        return { error: "not_found", message: "job does not exist" };
      }
      if (!(await userCanAccessProject(prisma, authUser.user.id, job.projectId))) {
        set.status = 404;
        return { error: "not_found", message: "job does not exist" };
      }
    },
    async open(ws) {
      // the upgrade was already authenticated in beforeHandle; the job id
      // rides the query string (visible in ws.data.query)
      const jobId = canonicalId((ws.data as { query?: { job_id?: string } }).query?.job_id);
      if (!jobId) {
        ws.close(4401, "unauthorized");
        return;
      }
      const socket = rawSocket(ws);
      hub.subscribe(jobId, socket);
      // membership re-check (Kimi round-8 low): a user removed from the
      // job's project stops receiving frames
      const protocol = (ws.data as unknown as { headers?: Record<string, unknown> }).headers?.[
        "sec-websocket-protocol"
      ];
      const token = String(protocol ?? "")
        .split(",")
        .map((s) => s.trim())[1];
      const userId = jwtSubject(token);
      if (userId) {
        let projectId = jobProjectCache.get(jobId);
        if (!projectId) {
          // cache miss must not silently disable the membership re-check
          // for the connection's lifetime: fall back to the DB
          try {
            const job = await prisma.otaJob.findUnique({
              where: { id: jobId },
              select: { projectId: true },
            });
            if (!job) {
              ws.close(4403, "access revoked");
              return;
            }
            projectId = job.projectId;
            jobProjectCache.set(jobId, projectId);
          } catch {
            ws.close(4403, "access revoked");
            return;
          }
        }
        accessCleanups.set(
          socket,
          scheduleMembershipCheck(socket, prisma, userId, [projectId], expCheckIntervalMs),
        );
      }
      armExpiryCheck(socket);
      ws.send(JSON.stringify({ type: "ready", job_id: jobId }));
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
      const jobId = canonicalId((ws.data as { query?: { job_id?: string } }).query?.job_id);
      if (jobId) hub.unsubscribe(jobId, rawSocket(ws));
      const socket = rawSocket(ws);
      const stop = accessCleanups.get(socket);
      if (stop) {
        stop();
        accessCleanups.delete(socket);
      }
      clearExpiry(socket);
    },
  });
}
