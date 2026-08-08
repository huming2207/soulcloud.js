/**
 * Realtime device online/offline stream for one project
 * (`GET /v1/ws/status?project_id=`).
 *
 * The browser WebSocket API cannot set custom headers, so the access
 * token travels in the subprotocol list: `["soulcloud", "<access
 * token>"]`. Frames:
 *
 *   { "type": "ready", project_id }                    -> stream open
 *   { "type": "status", device_uid, online, ts }       -> one status event
 *   { "type": "pong" }                                 -> heartbeat, ignored
 *
 * New connections first receive the server's known state for the
 * project's devices, then live transitions. Connection handling
 * (subprotocol auth, backoff reconnect, status) is shared with the
 * other streams via useWebSocketStream.
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";

export interface DeviceStatusEvent {
  device_uid: string;
  online: boolean;
  ts: number;
}

export type DeviceStatusStreamStatus = WebSocketStreamStatus;

export interface UseDeviceStatusStreamOptions {
  /** Called for every `{type:"status"}` frame. */
  onStatus?: (event: DeviceStatusEvent) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

export function useDeviceStatusStream(
  projectId: string | undefined,
  opts: UseDeviceStatusStreamOptions = {},
): DeviceStatusStreamStatus {
  return useWebSocketStream(
    projectId ? "/v1/ws/status" : "",
    projectId ? { project_id: projectId } : undefined,
    {
      enabled: opts.enabled,
      retryBaseMs: opts.retryBaseMs,
      onFrame: (frame) => {
        const { type, device_uid, online, ts } = frame as {
          type?: string;
          device_uid?: unknown;
          online?: unknown;
          ts?: unknown;
        };
        if (type === "status" && typeof device_uid === "string") {
          opts.onStatus?.({
            device_uid,
            online: online === true,
            ts: typeof ts === "number" ? ts : Date.now(),
          });
        }
      },
    },
  );
}
