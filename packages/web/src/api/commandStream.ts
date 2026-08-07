/**
 * Live command-batch status over WebSocket (`GET /v1/ws/commands?batch_id=`).
 *
 * Same subprotocol auth and reconnect behavior as useLogStream (shared
 * via useWebSocketStream). The server pushes JSON frames:
 *
 *   { "type": "ready", batch_id }   -> stream is open
 *   { "type": "batch", ... }        -> batch detail, same shape as
 *      REST GET /v1/command-batches/:id (summary + per-command states)
 *   { "type": "pong" }              -> heartbeat, ignored
 *
 * NOTIFY is lossy: when a push is missed the UI should keep the REST
 * fallback (re-query on reconnect / refresh).
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";
import type { CommandBatchDetail } from "./types";

export type CommandStreamStatus = WebSocketStreamStatus;

export interface UseCommandStreamOptions {
  /** Called for every `{type:"batch"}` frame with the batch detail. */
  onUpdate?: (detail: CommandBatchDetail) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

export function useCommandStream(
  batchId: string | undefined,
  opts: UseCommandStreamOptions = {},
): CommandStreamStatus {
  return useWebSocketStream(
    batchId ? "/v1/ws/commands" : "",
    batchId ? { batch_id: batchId } : undefined,
    {
      enabled: opts.enabled,
      retryBaseMs: opts.retryBaseMs,
      onFrame: (frame) => {
        const { type, batch_id, device_count, created_at, summary, commands } =
          frame as unknown as { type?: string } & CommandBatchDetail;
        if (type === "batch" && batch_id) {
          opts.onUpdate?.({
            batch_id,
            device_count,
            created_at,
            summary,
            commands,
          });
        }
      },
    },
  );
}
