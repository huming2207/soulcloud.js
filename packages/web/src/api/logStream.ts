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
 * On close the hook reconnects with exponential backoff
 * (retryBaseMs -> 2x -> 4x ... capped at 30s). Changing `deviceId`,
 * disabling the stream or unmounting cancels the pending retry and closes
 * the socket.
 */

import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "./http";
import type { LogEvent } from "./types";

/** A decoded log event pushed by the WS endpoint (same shape as REST). */
export type LogStreamEvent = LogEvent;

export type LogStreamStatus = "idle" | "connecting" | "open" | "error";

export interface UseLogStreamOptions {
  /** Called for every `{type:"log"}` frame. */
  onEvent?: (event: LogStreamEvent) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

const RETRY_MAX_MS = 30_000;

export function useLogStream(
  deviceId: string | undefined,
  opts: UseLogStreamOptions = {},
): LogStreamStatus {
  const { onEvent, enabled = true, retryBaseMs = 1_000 } = opts;

  const [status, setStatus] = useState<LogStreamStatus>("idle");

  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(retryBaseMs);
  // keep the latest callback without forcing a reconnect on identity change
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!deviceId || !enabled) {
      setStatus("idle");
      return;
    }

    let disposed = false;
    retryDelayRef.current = retryBaseMs;

    const connect = (): void => {
      if (disposed) return;
      const token = getAccessToken();
      const protocol = location.protocol === "https:" ? "wss://" : "ws://";
      const url = `${protocol}${location.host}/v1/ws/logs?device_id=${deviceId}`;
      const subprotocols = token ? ["soulcloud", token] : ["soulcloud"];

      setStatus("connecting");
      const ws = new WebSocket(url, subprotocols);
      socketRef.current = ws;

      ws.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return; // ignore malformed frames
        }
        if (typeof frame !== "object" || frame === null) return;
        const { type, event } = frame as {
          type?: string;
          event?: LogStreamEvent;
        };
        if (type === "ready") {
          setStatus("open");
        } else if (type === "log" && event) {
          onEventRef.current?.(event);
        }
        // "pong" and unknown frames are ignored
      };

      // no-op on purpose: the close event that follows drives the reconnect
      ws.onerror = () => {};

      ws.onclose = () => {
        if (disposed) return;
        setStatus("error");
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
        retryTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [deviceId, enabled, retryBaseMs]);

  return status;
}
