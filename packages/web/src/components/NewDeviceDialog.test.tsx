/**
 * NewDeviceDialog tests: creation flow and one-time credential display.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";

const devicesApi = {
  createDevice: mock(async () => ({
    device_id: "d1",
    device_uid: "uid-1",
    assigned_id: "sensor-1",
    mqtt_username: "uid-1",
    mqtt_password: "secret-password-xyz",
    note: "shown once",
  })),
  fetchDevices: mock(async () => ({ total: 0, devices: [] })),
  fetchDevice: mock(async () => ({})),
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

const { NewDeviceDialog } = await import("./NewDeviceDialog");

function renderDialog(onCreated = mock(() => {})) {
  return render(
    <I18nProvider>
      <NewDeviceDialog open onClose={() => {}} onCreated={onCreated} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  devicesApi.createDevice.mockClear();
  devicesApi.createDevice.mockResolvedValue({
    device_id: "d1",
    device_uid: "uid-1",
    assigned_id: "sensor-1",
    mqtt_username: "uid-1",
    mqtt_password: "secret-password-xyz",
    note: "shown once",
  });
});

describe("NewDeviceDialog", () => {
  test("renders the form fields", () => {
    renderDialog();
    expect(screen.getByLabelText(/assigned_id/)).not.toBeNull();
    expect(screen.getByLabelText(/device_uid/)).not.toBeNull();
    expect(screen.getByRole("button", { name: /创建|Create|Создать|Створити|Crea/i })).not.toBeNull();
  });

  test("creates a device and shows the one-time password", async () => {
    const onCreated = mock(() => {});
    renderDialog(onCreated);
    await userEvent.type(screen.getByLabelText(/assigned_id/), "sensor-1");
    await userEvent.type(screen.getByLabelText(/device_uid/), "uid-1");
    await userEvent.click(
      screen.getByRole("button", { name: /创建|Create|Создать|Створити|Crea/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/已创建|created|створено|Создано/i)).not.toBeNull(),
    );
    expect(screen.getByText("uid-1")).not.toBeNull();
    expect(screen.getByText("secret-password-xyz")).not.toBeNull();
    expect(devicesApi.createDevice).toHaveBeenCalledWith({
      project_id: "p1",
      assigned_id: "sensor-1",
      device_uid: "uid-1",
    });
    expect(onCreated).toHaveBeenCalled();
  });

  test("shows the API error and stays on the form", async () => {
    devicesApi.createDevice.mockRejectedValue(
      new Error("device_uid_taken: a device with this device_uid already exists"),
    );
    renderDialog();
    await userEvent.type(screen.getByLabelText(/assigned_id/), "sensor-1");
    await userEvent.type(screen.getByLabelText(/device_uid/), "dup-uid");
    await userEvent.click(
      screen.getByRole("button", { name: /创建|Create|Создать|Створити|Crea/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/device_uid_taken/)).not.toBeNull(),
    );
    // still on the form (no credential view)
    expect(screen.getByLabelText(/assigned_id/)).not.toBeNull();
  });
});
