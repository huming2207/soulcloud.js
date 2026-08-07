/**
 * Tests for useLogStream (src/api/logStream.ts): socket creation with the
 * token subprotocol, ready/log/pong frame handling, backoff reconnect and
 * teardown behavior. happy-dom does not provide a scriptable WebSocket
 * implementation, so a mock class is installed on globalThis.WebSocket.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setAccessToken } from "./http";
import { useLogStream, type LogStreamEvent } from "./logStream";

// --- mock WebSocket ----------------------------------------------------------

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
    this.protocols = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : [];
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  // --- test-only triggers (not part of the real API) ---
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
});

const sampleEvent: LogStreamEvent = {
  id: "evt-1",
  received_at: "2026-08-06T10:00:00.000Z",
  device_time_ms: "12345",
  sequence: 7,
  packet_type: 1,
  level: 2,
  tag: "demo",
  message: "hello from device",
  decode_state: "decodable",
};

describe("useLogStream", () => {
  test("creates a WebSocket with device_id in the URL and the token subprotocol", () => {
    setAccessToken("tok-123");
    const { result } = renderHook(() => useLogStream("dev-1"));
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost/v1/ws/logs?device_id=dev-1");
    expect(ws.protocols).toEqual(["soulcloud", "tok-123"]);
    expect(result.current).toBe("connecting");
  });

  test('turns open on a {type:"ready"} frame', () => {
    const { result } = renderHook(() => useLogStream("dev-1"));
    act(() => {
      MockWebSocket.instances[0]!.message(JSON.stringify({ type: "ready" }));
    });
    expect(result.current).toBe("open");
  });

  test('forwards {type:"log"} frames to onEvent', () => {
    const onEvent = mock<(event: LogStreamEvent) => void>();
    renderHook(() => useLogStream("dev-1", { onEvent }));
    act(() => {
      MockWebSocket.instances[0]!.message(
        JSON.stringify({ type: "log", device_id: "dev-1", event: sampleEvent }),
      );
    });
    expect(onEvent).toHaveBeenCalledWith(sampleEvent);
  });

  test("ignores pong frames", () => {
    const onEvent = mock<(event: LogStreamEvent) => void>();
    const { result } = renderHook(() => useLogStream("dev-1", { onEvent }));
    act(() => {
      MockWebSocket.instances[0]!.message(JSON.stringify({ type: "pong" }));
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(result.current).toBe("connecting");
  });

  test("reconnects with backoff after close", async () => {
    const { result } = renderHook(() => useLogStream("dev-1", { retryBaseMs: 10 }));
    act(() => {
      MockWebSocket.instances[0]!.closeConnection();
    });
    expect(result.current).toBe("error");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(result.current).toBe("connecting");
    expect(MockWebSocket.instances[1]!.url).toBe(
      "ws://localhost/v1/ws/logs?device_id=dev-1",
    );
  });

  test("rebuilds the socket when deviceId changes", () => {
    const onEvent = mock<(event: LogStreamEvent) => void>();
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useLogStream(id, { onEvent }),
      { initialProps: { id: "dev-1" } },
    );
    rerender({ id: "dev-2" });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0]!.closed).toBe(true);
    expect(MockWebSocket.instances[1]!.url).toContain("device_id=dev-2");
  });

  test("unmount closes the socket and stops reconnects/callbacks", async () => {
    const onEvent = mock<(event: LogStreamEvent) => void>();
    const { unmount } = renderHook(() =>
      useLogStream("dev-1", { onEvent, retryBaseMs: 10 }),
    );
    const ws = MockWebSocket.instances[0]!;
    unmount();
    expect(ws.closed).toBe(true);
    act(() => {
      ws.closeConnection();
      ws.message(JSON.stringify({ type: "log", device_id: "dev-1", event: sampleEvent }));
    });
    expect(onEvent).not.toHaveBeenCalled();
    // well past retryBaseMs: no reconnect must have been scheduled
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
