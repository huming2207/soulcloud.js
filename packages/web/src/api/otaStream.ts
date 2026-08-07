/**
 * Live OTA job progress stream over WebSocket (`GET /v1/ws/ota?job_id=`).
 *
 * The browser WebSocket API cannot set custom headers, so the access token
 * travels in the subprotocol list: `["soulcloud", "<access token>"]`. The
 * server pushes JSON frames:
 *
 *   { "type": "ready", job_id }     -> stream is open
 *   { "type": "ota", job_id, state, targets, summary } -> one OtaStreamUpdate
 *   { "type": "pong" }              -> heartbeat, ignored
 *
 * Connection handling (subprotocol auth, backoff reconnect, status) is
 * shared with the log/command streams via useWebSocketStream; this hook
 * only maps the frames to `onUpdate` callbacks.
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";
import type { OtaJobTarget, OtaTargetState } from "./types";

/** Job-level state derived server-side from the target states. */
export type OtaJobState = "running" | "completed" | "failed";

/** An OTA update pushed by the WS endpoint (same shape as REST). */
export interface OtaStreamUpdate {
  job_id: string;
  release_id: string;
  created_at: string;
  state: OtaJobState;
  targets: OtaJobTarget[];
  summary: Partial<Record<OtaTargetState, number>>;
}

export type OtaStreamStatus = WebSocketStreamStatus;

export interface UseOtaStreamOptions {
  /** Called for every `{type:"ota"}` frame. */
  onUpdate?: (update: OtaStreamUpdate) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

export function useOtaStream(
  jobId: string | undefined,
  opts: UseOtaStreamOptions = {},
): OtaStreamStatus {
  return useWebSocketStream(
    jobId ? "/v1/ws/ota" : "",
    jobId ? { job_id: jobId } : undefined,
    {
      enabled: opts.enabled,
      retryBaseMs: opts.retryBaseMs,
      onFrame: (frame) => {
        const { type, ...rest } = frame as { type?: string } & Partial<OtaStreamUpdate>;
        if (type === "ota" && rest.job_id) {
          opts.onUpdate?.(rest as OtaStreamUpdate);
        }
      },
    },
  );
}
