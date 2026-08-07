/**
 * LogsView tests: event rendering, undecodable fallback, raw toggle,
 * cursor pagination (load earlier / back to latest) and polling behavior.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  timeoutManager,
  type TimeoutProvider,
} from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { LogListResponse } from "../api/types";

const logsApi = {
  fetchDeviceLogs: mock(
    async (
      _deviceId: string,
      _params: { limit?: number; cursor?: string; includeRaw?: boolean },
    ): Promise<LogListResponse> => ({ events: [], next_cursor: null }),
  ),
};
mock.module("../api/logs", () => logsApi);

const { LogsView } = await import("./LogsView");

function renderLogs() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <LogsView deviceId="d1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

const sampleEvents = {
  events: [
    {
      id: "1",
      received_at: "2026-08-06T10:00:00.000Z",
      device_time_ms: "12345",
      sequence: 1,
      packet_type: 1,
      level: 2,
      tag: "demo",
      message: "hello world",
      decode_state: "decodable" as const,
    },
    {
      id: "2",
      received_at: "2026-08-06T10:00:01.000Z",
      device_time_ms: "13000",
      sequence: 2,
      packet_type: 1,
      level: 4,
      tag: null,
      message: null,
      decode_state: "unknown_fw" as const,
      raw_packet_b64: "AAECAwQ=",
    },
  ],
  next_cursor: null,
};

/**
 * LogsView builds its query key as ["logs", deviceId, cursor, includeRaw],
 * so the cache lets us assert the resolved polling configuration directly
 * (refetchInterval is not part of the public QueryOptions type).
 */
function refetchIntervalOf(query: unknown): unknown {
  return (query as { options?: { refetchInterval?: unknown } } | undefined)?.options
    ?.refetchInterval;
}

type TimerId = ReturnType<typeof setTimeout>;

/**
 * The shared react-query timer provider. Swapping it lets the polling test
 * observe the refetch interval without waiting real 5s gaps; only react-query
 * timers go through this provider, so the captured callbacks are unambiguous.
 */
const defaultTimerProvider: TimeoutProvider = {
  setTimeout: (cb, delay) => setTimeout(cb, delay),
  clearTimeout: (id) => clearTimeout(id as TimerId | undefined),
  setInterval: (cb, delay) => setInterval(cb, delay),
  clearInterval: (id) => clearInterval(id as TimerId | undefined),
};

function setTimerProvider(provider: TimeoutProvider) {
  // react-query logs a dev-only warning when the shared timer provider is
  // swapped after it has been used; keep the test output clean.
  const originalError = console.error;
  console.error = () => {};
  try {
    timeoutManager.setTimeoutProvider(provider);
  } finally {
    console.error = originalError;
  }
}

beforeEach(() => {
  logsApi.fetchDeviceLogs.mockClear();
  logsApi.fetchDeviceLogs.mockResolvedValue(sampleEvents);
});

describe("LogsView", () => {
  test("shows the empty state", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({ events: [], next_cursor: null });
    renderLogs();
    await waitFor(() =>
      expect(screen.getByText(/暂无日志事件|No log events|Событий журнала нет/i)).not.toBeNull(),
    );
  });

  test("renders decodable events with tag and message", async () => {
    renderLogs();
    await waitFor(() => expect(screen.getByText("hello world")).not.toBeNull());
    expect(screen.getByText("[demo]")).not.toBeNull();
    expect(screen.getByText("L2")).not.toBeNull();
  });

  test("renders undecodable events with a placeholder", async () => {
    renderLogs();
    await waitFor(() =>
      expect(screen.getByText(/无法解码|undecodable|не удалось декодировать/i)).not.toBeNull(),
    );
  });

  test("raw packets appear only after enabling the toggle", async () => {
    renderLogs();
    await waitFor(() => expect(screen.getByText("hello world")).not.toBeNull());
    expect(screen.queryByText(/raw: AAECAwQ=/)).toBeNull();
    await userEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByText("raw: AAECAwQ=")).not.toBeNull());
  });

  test("shows the load-earlier button when a cursor is present", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: sampleEvents.events,
      next_cursor: "7",
    });
    renderLogs();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /加载更早|Load earlier/i })).not.toBeNull(),
    );
  });

  test("load earlier refetches the older page with the returned cursor", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: sampleEvents.events,
      next_cursor: "7",
    });
    renderLogs();
    await userEvent.click(
      await screen.findByRole("button", { name: /加载更早|Load earlier/i }),
    );
    await waitFor(() => {
      const lastCall = logsApi.fetchDeviceLogs.mock.calls.at(-1);
      expect(lastCall?.[0]).toBe("d1");
      expect(lastCall?.[1]).toEqual({
        limit: 100,
        cursor: "7",
        includeRaw: false,
      });
    });
  });

  test("back to latest resets the cursor to the newest page", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: sampleEvents.events,
      next_cursor: "7",
    });
    renderLogs();
    await userEvent.click(
      await screen.findByRole("button", { name: /加载更早|Load earlier/i }),
    );
    await waitFor(() =>
      expect(logsApi.fetchDeviceLogs.mock.calls.at(-1)?.[1]?.cursor).toBe("7"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /回到最新|Back to latest/i }),
    );
    await waitFor(() => {
      const lastCall = logsApi.fetchDeviceLogs.mock.calls.at(-1);
      expect(lastCall?.[1]?.cursor).toBeUndefined();
      expect(lastCall?.[1]?.limit).toBe(100);
      expect(lastCall?.[1]?.includeRaw).toBe(false);
    });
    // the button disappears once back on the newest page
    expect(screen.queryByRole("button", { name: /回到最新|Back to latest/i })).toBeNull();
  });

  test("toggling raw packets resets the cursor to the newest page", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: sampleEvents.events,
      next_cursor: "7",
    });
    const { queryClient } = renderLogs();
    await userEvent.click(
      await screen.findByRole("button", { name: /加载更早|Load earlier/i }),
    );
    await waitFor(() =>
      expect(logsApi.fetchDeviceLogs.mock.calls.at(-1)?.[1]?.cursor).toBe("7"),
    );
    expect(
      queryClient.getQueryCache().find({ queryKey: ["logs", "d1", "7", false] }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      const lastCall = logsApi.fetchDeviceLogs.mock.calls.at(-1);
      expect(lastCall?.[1]?.cursor).toBeUndefined();
      expect(lastCall?.[1]?.includeRaw).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /回到最新|Back to latest/i })).toBeNull();
    // the raw view on the newest page polls again
    expect(
      refetchIntervalOf(
        queryClient.getQueryCache().find({ queryKey: ["logs", "d1", null, true] }),
      ),
    ).toBe(5000);
  });

  test("polls the newest page every 5s and stops polling on older pages", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: sampleEvents.events,
      next_cursor: "7",
    });
    const intervals: Array<{ callback: () => void; delay: number }> = [];
    let nextId = 1;
    setTimerProvider({
      setTimeout: (cb, delay) => setTimeout(cb, delay),
      clearTimeout: (id) => clearTimeout(id as TimerId | undefined),
      setInterval: (cb, delay) => {
        intervals.push({ callback: cb, delay });
        return nextId++;
      },
      clearInterval: () => {},
    });
    let result: ReturnType<typeof renderLogs> | undefined;
    try {
      result = renderLogs();
      await screen.findByText("hello world");
      await waitFor(() => expect(logsApi.fetchDeviceLogs.mock.calls.length).toBe(1));

      // newest page: configured to refetch every 5 seconds
      const latest = () =>
        result!.queryClient.getQueryCache().find({ queryKey: ["logs", "d1", null, false] });
      expect(refetchIntervalOf(latest())).toBe(5000);
      const pollIntervals = intervals.filter((i) => i.delay === 5000);
      expect(pollIntervals.length).toBeGreaterThan(0);

      // a fired poll interval triggers a refetch of the newest page
      const callsBefore = logsApi.fetchDeviceLogs.mock.calls.length;
      const pollInterval = pollIntervals[pollIntervals.length - 1];
      expect(pollInterval).toBeDefined();
      await act(async () => {
        pollInterval!.callback();
      });
      await waitFor(() =>
        expect(logsApi.fetchDeviceLogs.mock.calls.length).toBe(callsBefore + 1),
      );

      // browsing an older page stops the polling
      await userEvent.click(
        screen.getByRole("button", { name: /加载更早|Load earlier/i }),
      );
      await waitFor(() =>
        expect(logsApi.fetchDeviceLogs.mock.calls.at(-1)?.[1]?.cursor).toBe("7"),
      );
      expect(
        refetchIntervalOf(
          result!.queryClient.getQueryCache().find({ queryKey: ["logs", "d1", "7", false] }),
        ),
      ).toBe(false);
      const pollRegistrationsAfterPaging = intervals.filter((i) => i.delay === 5000).length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(intervals.filter((i) => i.delay === 5000).length).toBe(
        pollRegistrationsAfterPaging,
      );

      // returning to the newest page resumes the polling
      await userEvent.click(
        screen.getByRole("button", { name: /回到最新|Back to latest/i }),
      );
      await waitFor(() => expect(refetchIntervalOf(latest())).toBe(5000));
    } finally {
      setTimerProvider(defaultTimerProvider);
      result?.unmount();
    }
  });
});
