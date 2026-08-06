/**
 * DeployDialog tests: device selection and job creation flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { DeviceListResponse } from "../api/types";

const devicesApi = {
  fetchDevices: mock(
    async (): Promise<DeviceListResponse> => ({ total: 0, devices: [] }),
  ),
};
mock.module("../api/devices", () => devicesApi);

const firmwareApi = {
  deployRelease: mock(async () => ({
    job_id: "j1",
    targets: [{ device_id: "d1", device_uid: "u1", state: "pending" }],
  })),
};
mock.module("../api/firmware", () => firmwareApi);

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

const { DeployDialog } = await import("./DeployDialog");

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/firmware"]}>
          <Routes>
            <Route
              path="/firmware"
              element={<DeployDialog releaseId="r1" open onClose={() => {}} />}
            />
            <Route path="/ota-jobs/:jobId" element={<div>JOB-DETAIL</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  firmwareApi.deployRelease.mockClear();
  firmwareApi.deployRelease.mockResolvedValue({
    job_id: "j1",
    targets: [{ device_id: "d1", device_uid: "u1", state: "pending" }],
  });
});

describe("DeployDialog", () => {
  test("deploys to selected devices and offers job navigation", async () => {
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        { device_id: "d1", device_uid: "u1", assigned_id: "sensor-a", auth_revoked: false, firmware: null },
      ],
    });
    renderDialog();
    // open the device Autocomplete and pick the device
    await userEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByText(/sensor-a/);
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /部署|Deploy|Развернуть|Розгорнути/i }));
    await waitFor(() =>
      expect(screen.getByText(/部署已创建|Deployment created|Развёртывание создано/i)).not.toBeNull(),
    );
    expect(firmwareApi.deployRelease).toHaveBeenCalledWith("r1", ["d1"]);
    // navigating to the job page
    await userEvent.click(screen.getByRole("button", { name: /查看任务|View job|К задаче/i }));
    await waitFor(() => expect(screen.getByText("JOB-DETAIL")).not.toBeNull());
  });

  test("surfaces deploy errors", async () => {
    firmwareApi.deployRelease.mockRejectedValue(
      new Error("target_devices_not_found: missing"),
    );
    devicesApi.fetchDevices.mockResolvedValue({
      total: 1,
      devices: [
        { device_id: "d1", device_uid: "u1", assigned_id: "sensor-a", auth_revoked: false, firmware: null },
      ],
    });
    renderDialog();
    await userEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByText(/sensor-a/);
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /部署|Deploy|Развернуть|Розгорнути/i }));
    await waitFor(() =>
      expect(screen.getByText(/target_devices_not_found/)).not.toBeNull(),
    );
  });
});
