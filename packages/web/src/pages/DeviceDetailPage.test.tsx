/**
 * DeviceDetailPage tests: overview tabs and the revoke flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { DeviceDetail } from "../api/types";

const devicesApi = {
  fetchDevice: mock(async (): Promise<DeviceDetail> => ({
    device_id: "d1",
    device_uid: "uid-1",
    assigned_id: "sensor-a",
    project_id: "p1",
    auth_revoked: false,
    next_command_sequence: "3",
    firmware: { fw_hash: "abc", reported_at: "2026-08-06T00:00:00Z" },
  })),
  fetchDeviceFirmwareState: mock(async () => ({
    device_id: "d1",
    device_uid: "uid-1",
    fw_hash: "abc",
    artifact_id: "a1",
    artifact_version: "v1.2.0",
    reported_at: "2026-08-06T00:00:00Z",
  })),
  revokeCredentials: mock(async () => ({
    device_id: "d1",
    revoked: true,
    session_killed: true,
  })),
  fetchDeviceCommands: mock(async () => ({ commands: [], next_cursor: null })),
  postCommandBatch: mock(async () => ({})),
  fetchCommandBatch: mock(async () => ({})),
  fetchDevices: mock(async () => ({ total: 0, devices: [] })),
  createDevice: mock(async () => ({})),
  issueCredentials: mock(async () => ({})),
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

const { DeviceDetailPage } = await import("./DeviceDetailPage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/devices/d1"]}>
          <Routes>
            <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devicesApi.revokeCredentials.mockClear();
  devicesApi.revokeCredentials.mockResolvedValue({
    device_id: "d1",
    revoked: true,
    session_killed: true,
  });
});

describe("DeviceDetailPage", () => {
  test("renders device info and firmware state", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    expect(screen.getByText("uid-1")).not.toBeNull();
    expect(screen.getByText(/v1\.2\.0/)).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
  });

  test("switches between the overview and logs tabs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    await userEvent.click(screen.getByRole("tab", { name: /日志|Logs/i }));
    await waitFor(() =>
      expect(screen.getByText(/暂无日志事件|No log events/i)).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("tab", { name: /概览|Overview/i }));
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
  });

  test("revokes credentials after confirmation", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /吊销凭据|Revoke credentials/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /确认吊销|Revoke$/i }),
    );
    await waitFor(() => expect(devicesApi.revokeCredentials).toHaveBeenCalledWith("d1"));
  });

  test("revoke errors are shown in the dialog", async () => {
    devicesApi.revokeCredentials.mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() => expect(screen.getByText("sensor-a")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /吊销凭据|Revoke credentials/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /确认吊销|Revoke$/i }),
    );
    await waitFor(() => expect(screen.getByText("boom")).not.toBeNull());
  });
});
