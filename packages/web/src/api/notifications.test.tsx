/**
 * Tests for useNotificationsStream: socket creation with the project_id
 * query + token subprotocol, ready/notification/pong frame handling,
 * reconnect and teardown. Uses the same mock WebSocket class as the
 * other stream hooks (happy-dom has no scriptable WS).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setAccessToken } from "./http";
import { useNotificationsStream } from "./notifications";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  protocols: string[];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    MockWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.({ data });
  }
  closeConnection(): void {
    this.onclose?.();
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  setAccessToken(null);
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  setAccessToken(null);
});

describe("useNotificationsStream", () => {
  test("connects with the project_id query and token subprotocol", async () => {
    setAccessToken("acc-1");
    const onNotification = mock(() => {});
    renderHook(() =>
      useNotificationsStream("p1", { onNotification, retryBaseMs: 10 }),
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toContain("/v1/ws/notifications?project_id=p1");
    expect(ws.protocols).toEqual(["soulcloud", "acc-1"]);
  });

  test("maps ready and notification frames; ignores pong", async () => {
    setAccessToken("acc-1");
    const onNotification = mock(() => {});
    const { result } = renderHook(() =>
      useNotificationsStream("p1", { onNotification, retryBaseMs: 10 }),
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.open();
      ws.message(JSON.stringify({ type: "ready", project_id: "p1" }));
      ws.message(JSON.stringify({ type: "pong" }));
      ws.message(
        JSON.stringify({
          type: "notification",
          notification: {
            type: "manual_approval",
            rollout_id: "r1",
            project_id: "p1",
            ts: 123,
          },
        }),
      );
    });
    await waitFor(() => expect(result.current).toBe("open"));
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith({
      type: "manual_approval",
      rollout_id: "r1",
      project_id: "p1",
      ts: 123,
    });
  });

  test("ignores frames without a rollout_id (malformed)", async () => {
    setAccessToken("acc-1");
    const onNotification = mock(() => {});
    renderHook(() => useNotificationsStream("p1", { onNotification, retryBaseMs: 10 }));
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.message(JSON.stringify({ type: "notification", notification: { type: "x" } }));
      ws.message("not-json");
    });
    expect(onNotification).not.toHaveBeenCalled();
  });

  test("no project id: stays idle and opens no socket", async () => {
    renderHook(() => useNotificationsStream(undefined, { retryBaseMs: 10 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(MockWebSocket.instances.length).toBe(0);
  });

  test("reconnects with backoff after a close, then unmount cleans up", async () => {
    setAccessToken("acc-1");
    renderHook(() => useNotificationsStream("p1", { retryBaseMs: 5 }));
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const first = MockWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.closeConnection();
    });
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(1));
    const second = MockWebSocket.instances.at(-1)!;
    expect(second.closed).toBe(false);
  });
});
