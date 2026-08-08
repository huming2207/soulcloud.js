/**
 * WS connection lifetime membership checks (Kimi round-8 low):
 * handshake validates project membership once, but a connection can
 * outlive it — a user removed from a project would otherwise keep
 * receiving realtime frames until reconnect. This schedules a periodic
 * re-check for the lifetime of the socket; a missing membership link
 * closes it with 4403 and the client hook's backoff reconnect presents
 * a fresh token (which the handshake rejects if the user is really
 * gone). Token lifecycle is covered separately by the M2 expiry check.
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
 * Re-checks project membership on a fixed interval until the socket
 * closes. A missing link closes the socket (4403 "access revoked").
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

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(async () => {
    if (timer === null) return; // already stopped
    if (socket.readyState !== 1) {
      // socket is gone (closed or closing); stop the timer
      stop();
      return;
    }
    try {
      for (const projectId of projectIds) {
        const link = await prisma.userProject.findUnique({
          where: { userId_projectId: { userId, projectId } },
          select: { userId: true },
        });
        if (!link) {
          stop();
          try {
            socket.close(ACCESS_REVOKED_CLOSE_CODE, "access revoked");
          } catch {
            // socket is already closing
          }
          return;
        }
      }
    } catch {
      // transient DB failure: keep the connection; the next tick re-checks
    }
  }, intervalMs);

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
