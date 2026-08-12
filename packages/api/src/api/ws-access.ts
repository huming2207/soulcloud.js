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
 */

import type { ServerWebSocket } from "bun";
import type { PrismaClient } from "@soulcloud/core";

/** 4401 is also used by M2 (token expired); 4403 distinguishes revoked access. */
const ACCESS_REVOKED_CLOSE_CODE = 4403;

/**
 * Re-checks project membership on a fixed interval until the socket closes.
 * A missing link closes the socket (4403 "access revoked"). Each pass uses
 * one batched query, and a slow query never overlaps the next interval.
 * Transient DB errors keep the connection (never kill on hiccups).
 *
 * Self-cleaning: the timer stops itself once the socket is no longer
 * OPEN, so the caller's close handler does not need to cooperate.
 *
 * @returns a cleanup function (idempotent; clears the timer early).
 */
export function scheduleMembershipCheck(
  socket: ServerWebSocket,
  prisma: PrismaClient,
  userId: string,
  projectIds: string[],
  intervalMs: number,
): () => void {
  if (projectIds.length === 0 || intervalMs <= 0) return () => {};

  const uniqueProjectIds = [...new Set(projectIds)];

  let timer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const checkMembership = () => {
    if (timer === null) return; // already stopped
    if (socket.readyState !== 1) {
      // socket is gone (closed or closing); stop the timer
      stop();
      return;
    }
    if (checking) return;
    checking = true;
    void prisma.userProject
      .findMany({
        where: { userId, projectId: { in: uniqueProjectIds } },
        select: { projectId: true },
      })
      .then((links) => {
        const allowed = new Set(links.map((link) => link.projectId));
        if (uniqueProjectIds.some((projectId) => !allowed.has(projectId))) {
          stop();
          try {
            socket.close(ACCESS_REVOKED_CLOSE_CODE, "access revoked");
          } catch {
            // socket is already closing
          }
        }
      })
      .catch(() => {
        // Transient DB failure: keep the connection; the next tick re-checks.
      })
      .finally(() => {
        checking = false;
      });
  };

  timer = setInterval(checkMembership, intervalMs);

  return stop;
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
