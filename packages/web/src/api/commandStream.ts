/**
 * Live command-batch status over WebSocket (`GET /v1/ws/commands?batch_id=`).
 *
 * Same subprotocol auth and reconnect behavior as useLogStream (shared
 * via useWebSocketStream). The server pushes JSON frames:
 *
 *   { "type": "ready", batch_id }   -> stream is open
 *   { "type": "batch", batch_id, device_count, summary, updated }
 *                                   -> change signal (no per-command
 *      payload); re-fetch the detail via REST GET /v1/command-batches/:id
 *   { "type": "pong" }              -> heartbeat, ignored
 *
 * NOTIFY is lossy: when a push is missed the UI should keep the REST
 * fallback (re-query on reconnect / refresh).
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";

/**
 * Signal frame pushed by the server: the batch changed, re-fetch the
 * detail via REST. The per-command array is deliberately NOT carried
 * over the socket (a 1000-command batch would cost ~200KB per debounce
 * window per subscriber); summary is included for lightweight consumers.
 */
export interface CommandBatchSignal {
  batch_id: string;
  device_count: number;
  summary: Record<string, number>;
  updated: number;
}

export type CommandStreamStatus = WebSocketStreamStatus;

export interface UseCommandStreamOptions {
  /** Called for every `{type:"batch"}` frame with the change signal. */
  onUpdate?: (signal: CommandBatchSignal) => void;
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
        const { type, batch_id, device_count, summary, updated } =
          frame as unknown as { type?: string } & CommandBatchSignal;
        if (type === "batch" && batch_id) {
          opts.onUpdate?.({ batch_id, device_count, summary, updated });
        }
      },
    },
  );
}
