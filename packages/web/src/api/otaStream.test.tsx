/**
 * Tests for useOtaStream (src/api/otaStream.ts): socket creation with the
 * token subprotocol, ready/ota/pong frame handling, backoff reconnect and
 * teardown behavior. happy-dom does not provide a scriptable WebSocket
 * implementation, so a mock class is installed on globalThis.WebSocket.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setAccessToken } from "./http";
import { useOtaStream, type OtaStreamUpdate } from "./otaStream";

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

const sampleUpdate: OtaStreamUpdate = {
  job_id: "job-1",
  release_id: "rel-1",
  created_at: "2026-08-06T10:00:00.000Z",
  state: "running",
  targets: [
    {
      device_id: "dev-1",
      device_uid: "demo-device",
      state: "delivered",
      delivered_at: "2026-08-06T10:00:01.000Z",
      confirmed_at: null,
      result_code: null,
      result_message: null,
      current_fw: null,
    },
  ],
  summary: { delivered: 1 },
};

describe("useOtaStream", () => {
  test("creates a WebSocket with job_id in the URL and the token subprotocol", () => {
    setAccessToken("tok-123");
    const { result } = renderHook(() => useOtaStream("job-1"));
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost/v1/ws/ota?job_id=job-1");
    expect(ws.protocols).toEqual(["soulcloud", "tok-123"]);
    expect(result.current).toBe("connecting");
  });

  test('turns open on a {type:"ready"} frame', () => {
    const { result } = renderHook(() => useOtaStream("job-1"));
    act(() => {
      MockWebSocket.instances[0]!.message(JSON.stringify({ type: "ready", job_id: "job-1" }));
    });
    expect(result.current).toBe("open");
  });

  test('forwards {type:"ota"} frames to onUpdate', () => {
    const onUpdate = mock<(update: OtaStreamUpdate) => void>();
    renderHook(() => useOtaStream("job-1", { onUpdate }));
    act(() => {
      MockWebSocket.instances[0]!.message(
        JSON.stringify({ type: "ota", ...sampleUpdate }),
      );
    });
    expect(onUpdate).toHaveBeenCalledWith(sampleUpdate);
  });

  test("ignores pong frames", () => {
    const onUpdate = mock<(update: OtaStreamUpdate) => void>();
    const { result } = renderHook(() => useOtaStream("job-1", { onUpdate }));
    act(() => {
      MockWebSocket.instances[0]!.message(JSON.stringify({ type: "pong" }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.current).toBe("connecting");
  });

  test("reconnects with backoff after close", async () => {
    const { result } = renderHook(() => useOtaStream("job-1", { retryBaseMs: 10 }));
    act(() => {
      MockWebSocket.instances[0]!.closeConnection();
    });
    expect(result.current).toBe("error");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(result.current).toBe("connecting");
    expect(MockWebSocket.instances[1]!.url).toBe(
      "ws://localhost/v1/ws/ota?job_id=job-1",
    );
  });

  test("rebuilds the socket when jobId changes", () => {
    const onUpdate = mock<(update: OtaStreamUpdate) => void>();
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useOtaStream(id, { onUpdate }),
      { initialProps: { id: "job-1" } },
    );
    rerender({ id: "job-2" });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0]!.closed).toBe(true);
    expect(MockWebSocket.instances[1]!.url).toContain("job_id=job-2");
  });

  test("unmount closes the socket and stops reconnects/callbacks", async () => {
    const onUpdate = mock<(update: OtaStreamUpdate) => void>();
    const { unmount } = renderHook(() =>
      useOtaStream("job-1", { onUpdate, retryBaseMs: 10 }),
    );
    const ws = MockWebSocket.instances[0]!;
    unmount();
    expect(ws.closed).toBe(true);
    act(() => {
      ws.closeConnection();
      ws.message(JSON.stringify({ type: "ota", ...sampleUpdate }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    // well past retryBaseMs: no reconnect must have been scheduled
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
