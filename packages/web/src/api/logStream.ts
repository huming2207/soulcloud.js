/**
 * Live log stream for one device over WebSocket (`GET /v1/ws/logs?device_id=`).
 *
 * The browser WebSocket API cannot set custom headers, so the access token
 * travels in the subprotocol list: `["soulcloud", "<access token>"]`. The
 * server pushes JSON frames:
 *
 *   { "type": "ready", ... }             -> stream is open
 *   { "type": "log", device_id, event }  -> one LogStreamEvent
 *   { "type": "pong" }                   -> heartbeat, ignored
 *
 * Connection handling (subprotocol auth, backoff reconnect, status) is
 * shared with the command stream via useWebSocketStream; this hook only
 * maps the frames to `onEvent` callbacks.
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";
import type { LogEvent } from "./types";

/** A decoded log event pushed by the WS endpoint (same shape as REST). */
export type LogStreamEvent = LogEvent;

export type LogStreamStatus = WebSocketStreamStatus;

export interface UseLogStreamOptions {
  /** Called for every `{type:"log"}` frame. */
  onEvent?: (event: LogStreamEvent) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

export function useLogStream(
  deviceId: string | undefined,
  opts: UseLogStreamOptions = {},
): LogStreamStatus {
  return useWebSocketStream(
    deviceId ? "/v1/ws/logs" : "",
    deviceId ? { device_id: deviceId } : undefined,
    {
      enabled: opts.enabled,
      retryBaseMs: opts.retryBaseMs,
      onFrame: (frame) => {
        const { type, event } = frame as { type?: string; event?: LogStreamEvent };
        if (type === "log" && event) {
          opts.onEvent?.(event);
        }
      },
    },
  );
}
