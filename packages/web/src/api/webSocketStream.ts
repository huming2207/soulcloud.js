/**
 * Generic WebSocket stream hook shared by the log stream and the command
 * stream (and any future realtime endpoint).
 *
 * Opens `ws(s)://<host><path>?<query>` with the subprotocol list
 * `["soulcloud", "<access token>"]` (the browser WebSocket API cannot set
 * arbitrary headers, so the token rides the subprotocol). A
 * `{ "type": "ready" }` frame marks the stream open. On close the hook
 * reconnects with exponential backoff (retryBaseMs -> 2x -> 4x ... capped
 * at 30s). Changing `path`/`query`, disabling the stream or unmounting
 * cancels the pending retry and closes the socket.
 */

import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "./http";

export type WebSocketStreamStatus = "idle" | "connecting" | "open" | "error";

export interface UseWebSocketStreamOptions {
  /** Called for every parsed JSON frame (after built-in ready handling). */
  onFrame?: (frame: Record<string, unknown>) => void;
  /** When false the socket stays closed and the status is "idle". */
  enabled?: boolean;
  /** Initial reconnect delay; doubles per attempt (tests use a short value). */
  retryBaseMs?: number;
}

const RETRY_MAX_MS = 30_000;
const WS_PROTOCOL = "soulcloud";

/**
 * Subscribes to a WebSocket stream. Pass an empty `path` (or `enabled:
 * false`) to keep the socket closed with status "idle".
 */
export function useWebSocketStream(
  path: string,
  query: Record<string, string> | undefined,
  opts: UseWebSocketStreamOptions = {},
): WebSocketStreamStatus {
  const { onFrame, enabled = true, retryBaseMs = 1_000 } = opts;

  const [status, setStatus] = useState<WebSocketStreamStatus>("idle");

  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(retryBaseMs);
  // keep the latest callback without forcing a reconnect on identity change
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // depend on the serialized query, not the object identity, so callers
  // may pass an inline literal without reconnecting every render
  const queryKey = query ? new URLSearchParams(query).toString() : "";

  useEffect(() => {
    if (!path || !enabled) {
      setStatus("idle");
      return;
    }

    let disposed = false;
    retryDelayRef.current = retryBaseMs;

    const connect = (): void => {
      if (disposed) return;
      const token = getAccessToken();
      const protocol = location.protocol === "https:" ? "wss://" : "ws://";
      const url = `${protocol}${location.host}${path}${queryKey ? `?${queryKey}` : ""}`;
      const subprotocols = token ? [WS_PROTOCOL, token] : [WS_PROTOCOL];

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
        const parsed = frame as Record<string, unknown>;
        if (parsed.type === "ready") {
          setStatus("open");
        }
        onFrameRef.current?.(parsed);
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
  }, [path, queryKey, enabled, retryBaseMs]);

  return status;
}
