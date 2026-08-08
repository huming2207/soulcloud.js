/**
 * Rollout lifecycle notifications stream (`GET /v1/ws/notifications?project_id=`).
 *
 * The access token rides the subprotocol list (`["soulcloud", token]`).
 * The server pushes:
 *
 *   { "type": "ready", project_id }            -> stream open
 *   { "type": "notification", notification:
 *       { type, rollout_id, project_id, ts } } -> one notification
 *   { "type": "pong" }                         -> heartbeat, ignored
 *
 * Connection handling is shared with the other streams via
 * useWebSocketStream; this hook maps frames to `onNotification`.
 */

import { useWebSocketStream, type WebSocketStreamStatus } from "./webSocketStream";

/** Rollout lifecycle event types pushed by the server. */
export type RolloutNotificationType =
  | "manual_approval"
  | "completed"
  | "paused"
  | "aborted"
  | "resumed";

export interface RolloutNotification {
  type: RolloutNotificationType;
  rollout_id: string;
  project_id: string;
  /** Server-side epoch milliseconds when the transition committed. */
  ts?: number;
}

export type NotificationsStreamStatus = WebSocketStreamStatus;

export interface UseNotificationsStreamOptions {
  /** Called for every `{type:"notification"}` frame. */
  onNotification?: (notification: RolloutNotification) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

export function useNotificationsStream(
  projectId: string | undefined,
  opts: UseNotificationsStreamOptions = {},
): NotificationsStreamStatus {
  return useWebSocketStream(
    projectId ? "/v1/ws/notifications" : "",
    projectId ? { project_id: projectId } : undefined,
    {
      enabled: opts.enabled,
      retryBaseMs: opts.retryBaseMs,
      onFrame: (frame) => {
        const notification = (frame as { notification?: RolloutNotification }).notification;
        if (notification?.rollout_id) {
          opts.onNotification?.(notification);
        }
      },
    },
  );
}
