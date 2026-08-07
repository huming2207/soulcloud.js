/**
 * Tests for useCommandStream (src/api/commandStream.ts): socket creation
 * with the batch_id query + token subprotocol, ready/batch/pong frame
 * handling, backoff reconnect and teardown behavior. Uses the same mock
 * WebSocket class as logStream.test.tsx (happy-dom has no scriptable WS).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setAccessToken } from "./http";
import { useCommandStream, type CommandStreamStatus } from "./commandStream";
import type { CommandBatchDetail } from "./types";

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

const sampleDetail: CommandBatchDetail = {
  batch_id: "batch-1",
  device_count: 2,
  created_at: "2026-08-06T10:00:00.000Z",
  summary: { queued: 1, device_completed: 1 },
  commands: [
    {
      command_id: "cmd-1",
      device_id: "dev-1",
      device_uid: "dev-uid-1",
      batch_id: "batch-1",
      sequence: "1",
      command: { cmd: "getConfig", args: null },
      state: "device_completed",
      result_code: 0,
      result: { code: 0, payload: null },
      created_at: "2026-08-06T10:00:00.000Z",
      delivery_expires_at: null,
      device_completed_at: "2026-08-06T10:00:01.000Z",
    },
    {
      command_id: "cmd-2",
      device_id: "dev-2",
      device_uid: "dev-uid-2",
      batch_id: "batch-1",
      sequence: "2",
      command: { cmd: "getConfig", args: null },
      state: "queued",
      result_code: null,
      result: null,
      created_at: "2026-08-06T10:00:00.000Z",
      delivery_expires_at: null,
      device_completed_at: null,
    },
  ],
};

describe("useCommandStream", () => {
  test("creates a WebSocket with batch_id in the URL and the token subprotocol", () => {
    setAccessToken("tok-123");
    const { result } = renderHook(() => useCommandStream("batch-1"));
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost/v1/ws/commands?batch_id=batch-1");
    expect(ws.protocols).toEqual(["soulcloud", "tok-123"]);
    expect(result.current).toBe("connecting");
  });

  test("stays idle while batchId is undefined", () => {
    const { result } = renderHook(() => useCommandStream(undefined));
    expect(result.current).toBe("idle");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test('turns open on a {type:"ready"} frame', () => {
    const { result } = renderHook(() => useCommandStream("batch-1"));
    act(() => {
      MockWebSocket.instances[0]!.message(
        JSON.stringify({ type: "ready", batch_id: "batch-1" }),
      );
    });
    expect(result.current).toBe("open");
  });

  test('forwards {type:"batch"} frames to onUpdate', () => {
    const onUpdate = mock<(detail: CommandBatchDetail) => void>();
    renderHook(() => useCommandStream("batch-1", { onUpdate }));
    act(() => {
      MockWebSocket.instances[0]!.message(
        JSON.stringify({ type: "batch", ...sampleDetail }),
      );
    });
    expect(onUpdate).toHaveBeenCalledWith(sampleDetail);
  });

  test("ignores pong frames", () => {
    const onUpdate = mock<(detail: CommandBatchDetail) => void>();
    const { result } = renderHook(() => useCommandStream("batch-1", { onUpdate }));
    act(() => {
      MockWebSocket.instances[0]!.message(JSON.stringify({ type: "pong" }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.current).toBe("connecting");
  });

  test("reconnects with backoff after close", async () => {
    const { result } = renderHook(() => useCommandStream("batch-1", { retryBaseMs: 10 }));
    act(() => {
      MockWebSocket.instances[0]!.closeConnection();
    });
    expect(result.current).toBe("error");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(result.current).toBe("connecting");
    expect(MockWebSocket.instances[1]!.url).toBe(
      "ws://localhost/v1/ws/commands?batch_id=batch-1",
    );
  });

  test("rebuilds the socket when batchId changes", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useCommandStream(id),
      { initialProps: { id: "batch-1" } },
    );
    rerender({ id: "batch-2" });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0]!.closed).toBe(true);
    expect(MockWebSocket.instances[1]!.url).toContain("batch_id=batch-2");
  });

  test("unmount closes the socket and stops reconnects/callbacks", async () => {
    const onUpdate = mock<(detail: CommandBatchDetail) => void>();
    const { unmount } = renderHook(() =>
      useCommandStream("batch-1", { onUpdate, retryBaseMs: 10 }),
    );
    const ws = MockWebSocket.instances[0]!;
    unmount();
    expect(ws.closed).toBe(true);
    act(() => {
      ws.closeConnection();
      ws.message(JSON.stringify({ type: "batch", ...sampleDetail }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    // well past retryBaseMs: no reconnect must have been scheduled
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("status stays a valid CommandStreamStatus throughout", () => {
    const { result } = renderHook(() => useCommandStream("batch-1"));
    const statuses: CommandStreamStatus[] = ["idle", "connecting", "open", "error"];
    expect(statuses).toContain(result.current);
  });
});
