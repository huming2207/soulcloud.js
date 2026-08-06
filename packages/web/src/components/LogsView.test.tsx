/**
 * LogsView tests: event rendering, undecodable fallback, raw toggle.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { LogListResponse } from "../api/types";

const logsApi = {
  fetchDeviceLogs: mock(
    async (): Promise<LogListResponse> => ({ events: [], next_cursor: null }),
  ),
};
mock.module("../api/logs", () => logsApi);

const { LogsView } = await import("./LogsView");

function renderLogs() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <LogsView deviceId="d1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
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
});
