/**
 * DevicesPage tests: empty-state guidance and data-grid rows.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { DeviceListResponse } from "../api/types";

const devicesApi = {
  fetchDevices: mock(
    async (): Promise<DeviceListResponse> => ({ total: 0, devices: [] }),
  ),
  fetchDevice: mock(async () => ({})),
  createDevice: mock(async () => ({})),
  issueCredentials: mock(async () => ({})),
  revokeCredentials: mock(async () => ({})),
  fetchDeviceCommands: mock(async () => ({ commands: [], next_cursor: null })),
  fetchCommandBatch: mock(async () => ({})),
  postCommandBatch: mock(async () => ({})),
  fetchDeviceFirmwareState: mock(async () => ({})),
  bindFirmwareState: mock(async () => ({})),
};
mock.module("../api/devices", () => devicesApi);

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

const { DevicesPage } = await import("./DevicesPage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter>
          <DevicesPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devicesApi.fetchDevices.mockClear();
  devicesApi.fetchDevices.mockResolvedValue({ total: 0, devices: [] });
});

describe("DevicesPage", () => {
  test("shows the empty-state guidance when the project has no devices", async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/还没有设备|No devices in this project|пока нет устройств|немає пристроїв|Non ci sono ancora dispositivi/i),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /新建设备|New Device|Новое устройство|Новий пристрій|Nuovo dispositivo/i }),
    ).not.toBeNull();
  });

  test("renders device rows with firmware and credential state", async () => {
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        {
          device_id: "d1",
          device_uid: "uid-1",
          assigned_id: "sensor-a",
          auth_revoked: true,
          firmware: { fw_hash: "abc123", reported_at: "2026-08-06T00:00:00Z" },
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    expect(screen.getByText("uid-1")).not.toBeNull();
    expect(screen.getByText(/已吊销|Revoked|Отозвано|Відкликано|Revocate/i)).not.toBeNull();
  });

  test("a failed load shows the error with a retry action, not an empty table", async () => {
    devicesApi.fetchDevices.mockRejectedValueOnce(new Error("network down"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/network down/)).not.toBeNull());
    // the empty-state hint must NOT appear (the user must not mistake a
    // failure for an empty project)
    expect(screen.queryByText(/还没有设备|No devices in this project/i)).toBeNull();
    // retry re-runs the query and recovers
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        {
          device_id: "d1",
          device_uid: "uid-1",
          assigned_id: "sensor-a",
          auth_revoked: false,
          firmware: null,
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i })).not.toBeNull(),
    );
    const retry = screen.getByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i });
    retry.click();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    expect(devicesApi.fetchDevices.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
