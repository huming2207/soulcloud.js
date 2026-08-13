/**
 * WS connection lifetime membership checks (Kimi round-8 low):
 * handshake validates project membership once, but a connection can
 * outlive it — a user removed from a project would otherwise keep
 * receiving realtime frames until reconnect. This schedules a periodic
 * re-check for the lifetime of the socket; a missing membership link
 * closes it with 4403. The client stops that resource stream instead of
 * retrying a token refresh that cannot restore removed membership. Token
 * lifecycle is covered separately by the expiry check.
 *
 * The re-check interval deliberately reuses the M2 token-expiry
 * interval of the calling stream (default 30s, injectable for tests):
 * one cadence, one knob.
 *
 * Checks are AGGREGATED per user: one timer and one batched query serve
 * every socket of the same user (a user can hold one socket per stream x
 * resource). Without aggregation a fully loaded process (5 streams x 500
 * sockets) would run ~5000 membership queries per minute.
 */

import type { ServerWebSocket } from "bun";
import type { PrismaClient } from "@soulcloud/core";

/** 4401 is also used by M2 (token expired); 4403 distinguishes revoked access. */
const ACCESS_REVOKED_CLOSE_CODE = 4403;

/**
 * Elysia 1.4 wraps the Bun ServerWebSocket in a NEW ElysiaWS instance for
 * every ws event (open/message/close), so the handler argument is never
 * referentially stable across events. Every Set/WeakMap keyed by a socket
 * MUST use the underlying raw Bun socket (stable per connection), or
 * cleanup never matches (leaked subscriber entries, stale connection
 * counters).
 */
export function rawSocket(ws: unknown): ServerWebSocket {
  const candidate = ws as { raw?: unknown } | null;
  return (candidate?.raw as ServerWebSocket | undefined) ?? (ws as ServerWebSocket);
}

/** One aggregated re-checker per user (timer + batched query). */
interface Rechecker {
  /** live socket -> the project ids it must still have access to. */
  entries: Map<ServerWebSocket, string[]>;
  timer: ReturnType<typeof setInterval> | null;
  checking: boolean;
  pendingCheck: boolean;
}

const recheckers = new Map<string, Rechecker>();

/**
 * Re-checks project membership on a fixed interval until the socket
 * closes. All sockets of the same user share one timer and one batched
 * query; a missing membership link closes the affected socket with 4403.
 * Transient DB errors keep every connection (never kill on hiccups).
 *
 * @returns a cleanup function (idempotent; stops the per-user timer once
 * the last socket of that user is gone).
 */
export function scheduleMembershipCheck(
  socket: ServerWebSocket,
  prisma: PrismaClient,
  userId: string,
  projectIds: string[],
  intervalMs: number,
): () => void {
  const uniqueProjectIds = [...new Set(projectIds)];
  if (uniqueProjectIds.length === 0 || intervalMs <= 0) return () => {};
  // Registration happens inside an async callback in the stream's open
  // handler; if the socket died before the callback ran (close raced the
  // registration), registering now would create a ghost entry whose stop()
  // can never run - the shared timer would then never retire. Skip dead
  // sockets entirely.
  if (socket.readyState !== 1) return () => {};

  let rechecker = recheckers.get(userId);
  if (!rechecker) {
    rechecker = { entries: new Map(), timer: null, checking: false, pendingCheck: false };
    recheckers.set(userId, rechecker);
  }
  rechecker.entries.set(socket, uniqueProjectIds);

  if (!rechecker.timer) {
    const run = (): void => {
      const current = recheckers.get(userId);
      if (!current) return; // retired while a tick was scheduled
      if (current.checking) {
        current.pendingCheck = true;
        return;
      }
      current.checking = true;
      const snapshot = [...current.entries.entries()];
      const allProjects = new Set<string>();
      for (const [, projects] of snapshot) {
        for (const p of projects) allProjects.add(p);
      }
      void prisma.userProject
        .findMany({
          where: { userId, projectId: { in: [...allProjects] } },
          select: { projectId: true },
        })
        .then((links) => {
          const allowed = new Set(links.map((link) => link.projectId));
          for (const [sock, projects] of snapshot) {
            if (sock.readyState !== 1) {
              // Dead socket: either its close handler already ran stop(),
              // or the close RACED the async open-side registration (the
              // entry was added after the socket died, so stop() never
              // saw it). Drop it here so the shared timer can retire.
              current.entries.delete(sock);
              continue;
            }
            if (projects.some((projectId) => !allowed.has(projectId))) {
              try {
                sock.close(ACCESS_REVOKED_CLOSE_CODE, "access revoked");
              } catch {
                // socket is already closing
              }
            }
          }
          // self-retire: no live sockets left -> stop the timer
          if (current.entries.size === 0) {
            if (current.timer !== null) {
              clearInterval(current.timer);
              current.timer = null;
            }
            recheckers.delete(userId);
          }
        })
        .catch(() => {
          // Transient DB failure: keep the connection; the next tick re-checks.
        })
        .finally(() => {
          current.checking = false;
          if (current.pendingCheck && recheckers.get(userId)) {
            current.pendingCheck = false;
            run();
          }
        });
    };
    rechecker.timer = setInterval(run, intervalMs);
  }

  return () => {
    const current = recheckers.get(userId);
    if (!current) return;
    current.entries.delete(socket);
    if (current.entries.size === 0) {
      if (current.timer !== null) {
        clearInterval(current.timer);
        current.timer = null;
      }
      recheckers.delete(userId);
    }
  };
}

/**
 * Extracts the subject (user id) from a handshake subprotocol token.
 * The signature was already verified during the handshake, so a plain
 * base64url decode is trustworthy here.
 */
export function jwtSubject(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const [, payloadPart] = token.split(".");
    if (!payloadPart) return null;
    const json = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return typeof json.sub === "string" && json.sub.length > 0 ? json.sub : null;
  } catch {
    return null;
  }
}
