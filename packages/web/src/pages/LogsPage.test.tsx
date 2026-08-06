/**
 * LogsPage tests: device picker and log stream wiring.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { DeviceListResponse, LogListResponse } from "../api/types";

const devicesApi = {
  fetchDevices: mock(
    async (): Promise<DeviceListResponse> => ({ total: 0, devices: [] }),
  ),
};
mock.module("../api/devices", () => devicesApi);

const logsApi = {
  fetchDeviceLogs: mock(
    async (): Promise<LogListResponse> => ({ events: [], next_cursor: null }),
  ),
};
mock.module("../api/logs", () => logsApi);

const projectCtx = {
  projects: [],
  projectId: "p1",
  project: { project_id: "p1", name: "Proj", device_count: 0 },
  setProjectId: mock(() => {}),
};
mock.module("../layout/ProjectContext", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => children,
  useProject: () => projectCtx,
}));

const { LogsPage } = await import("./LogsPage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <LogsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  logsApi.fetchDeviceLogs.mockClear();
  logsApi.fetchDeviceLogs.mockResolvedValue({ events: [], next_cursor: null });
});

describe("LogsPage", () => {
  test("prompts to select a device when none is chosen", async () => {
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        { device_id: "d1", device_uid: "uid-1", assigned_id: "sensor-a", auth_revoked: false, firmware: null },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/选择一台设备|Select a device|Выберите устройство/i),
      ).not.toBeNull(),
    );
    expect(logsApi.fetchDeviceLogs).not.toHaveBeenCalled();
  });

  test("shows a hint when the project has no devices", async () => {
    devicesApi.fetchDevices.mockResolvedValue({ total: 0, devices: [] });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/暂无设备|No devices in this project|нет устройств|немає пристроїв/i),
      ).not.toBeNull(),
    );
  });

  test("selecting a device loads its log stream", async () => {
    logsApi.fetchDeviceLogs.mockResolvedValue({
      events: [
        {
          id: "1",
          received_at: "2026-08-06T00:00:00Z",
          device_time_ms: "100",
          sequence: 1,
          packet_type: 1,
          level: 1,
          tag: "t",
          message: "from device",
          decode_state: "decodable",
        },
      ],
      next_cursor: null,
    });
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        { device_id: "d1", device_uid: "uid-1", assigned_id: "sensor-a", auth_revoked: false, firmware: null },
      ],
    });
    renderPage();
    // open the device select and pick the device
    await userEvent.click(screen.getByRole("combobox", { name: /设备|Device/i }));
    const option = await screen.findByText(/sensor-a/);
    await userEvent.click(option);
    await waitFor(() => expect(screen.getByText("from device")).not.toBeNull());
    expect(logsApi.fetchDeviceLogs).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ limit: 100 }),
    );
  });
});
