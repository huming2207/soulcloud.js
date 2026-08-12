/**
 * Tests for useWebSocketStream (src/api/webSocketStream.ts): socket
 * creation with the token subprotocol, and the 4401 token-expired
 * reconnect path (refresh before reconnect; stop retrying when the
 * refresh fails). happy-dom has no scriptable WebSocket, so a mock
 * class is installed on globalThis.WebSocket; the refresh endpoint is
 * mocked at the axios layer.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { setAccessToken, setRefreshToken } from "./http";
import { useWebSocketStream } from "./webSocketStream";

let refreshCalls = 0;
let refreshError: unknown;
let refreshedAccessToken = "fresh-token";

const instance = {
  interceptors: {
    request: {
      use: () => {},
    },
    response: {
      use: () => {},
    },
  },
};

mock.module("axios", () => ({
  default: {
    create: () => instance,
    post: async () => {
      refreshCalls += 1;
      if (refreshError) throw refreshError;
      return {
        data: { access_token: refreshedAccessToken, refresh_token: "rt-2" },
      };
    },
    isAxiosError: (e: unknown) =>
      typeof e === "object" && e !== null && "isAxiosError" in e,
  },
}));

// --- mock WebSocket ----------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  protocols: string[];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;

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

  // --- test-only trigger ---
  closeWith(code: number): void {
    this.onclose?.({ code });
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  setAccessToken("tok-123");
  setRefreshToken("rt-1");
  refreshCalls = 0;
  refreshError = undefined;
  refreshedAccessToken = "fresh-token";
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  // unmount any component left mounted by a previous test: its async
  // 4401 reconnect IIFE could otherwise resolve after the next test's
  // beforeEach and push a stray instance (slow-CI scheduling)
  cleanup();
});

describe("useWebSocketStream", () => {
  test("creates a socket with the token subprotocol", () => {
    const { result } = renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }),
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost/v1/ws/logs?device_id=dev-1");
    expect(ws.protocols).toEqual(["soulcloud", "tok-123"]);
    expect(result.current).toBe("connecting");
  });

  test("reconnects with backoff after a plain close", async () => {
    const { result } = renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 10 }),
    );
    act(() => {
      MockWebSocket.instances[0]!.closeWith(1006);
    });
    expect(result.current).toBe("error");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    // a plain close does not refresh
    expect(refreshCalls).toBe(0);
    expect(MockWebSocket.instances[1]!.protocols).toEqual(["soulcloud", "tok-123"]);
  });

  test("on 4401 refreshes the token and reconnects with it immediately", async () => {
    renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 10_000 }),
    );
    act(() => {
      MockWebSocket.instances[0]!.closeWith(4401);
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(refreshCalls).toBe(1);
    expect(MockWebSocket.instances[1]!.protocols).toEqual([
      "soulcloud",
      "fresh-token",
    ]);
    // immediate reconnect: no timer delay is involved (base delay is 10s
    // and would not fire within the waitFor window)
  });

  test("on 4401 with a failed refresh stops retrying", async () => {
    refreshError = new Error("refresh failed");
    renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 10 }),
    );
    act(() => {
      MockWebSocket.instances[0]!.closeWith(4401);
    });
    // give any (wrong) reconnect a chance to appear
    await Bun.sleep(50);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(refreshCalls).toBe(1);
  });

  test("on 4401 with an unchanged token backs off instead of reconnecting immediately", async () => {
    refreshedAccessToken = "tok-123";
    renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 40 }),
    );
    act(() => {
      MockWebSocket.instances[0]!.closeWith(4401);
    });
    await Bun.sleep(20);
    expect(refreshCalls).toBe(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  });

  test("on 4403 stops without refreshing or reconnecting", async () => {
    renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 10 }),
    );
    act(() => {
      MockWebSocket.instances[0]!.closeWith(4403);
    });
    await Bun.sleep(50);
    expect(refreshCalls).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("unmount stops reconnects", async () => {
    const { unmount } = renderHook(() =>
      useWebSocketStream("/v1/ws/logs", { device_id: "dev-1" }, { retryBaseMs: 10 }),
    );
    const ws = MockWebSocket.instances[0]!;
    unmount();
    expect(ws.closed).toBe(true);
    act(() => {
      ws.closeWith(1006);
    });
    await Bun.sleep(30);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
