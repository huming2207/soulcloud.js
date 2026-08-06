/**
 * CommandPanel tests: args JSON validation and the enqueue flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { CommandListResponse } from "../api/types";

const devicesApi = {
  fetchDevices: mock(async () => ({ total: 0, devices: [] })),
  fetchDevice: mock(async () => ({})),
  createDevice: mock(async () => ({})),
  issueCredentials: mock(async () => ({})),
  revokeCredentials: mock(async () => ({})),
  fetchDeviceCommands: mock(
    async (): Promise<CommandListResponse> => ({ commands: [], next_cursor: null }),
  ),
  fetchCommandBatch: mock(async () => ({})),
  postCommandBatch: mock(async () => ({ batch_id: "b1", device_count: 1 })),
  fetchDeviceFirmwareState: mock(async () => ({})),
  bindFirmwareState: mock(async () => ({})),
};
mock.module("../api/devices", () => devicesApi);

const { CommandPanel } = await import("./CommandPanel");

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <CommandPanel deviceId="d1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devicesApi.postCommandBatch.mockClear();
  devicesApi.postCommandBatch.mockResolvedValue({ batch_id: "b1", device_count: 1 });
});

describe("CommandPanel form validation", () => {
  test("rejects args that are not a JSON array", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    fireEvent.change(screen.getByLabelText(/参数 args|Arguments/), {
      target: { value: '{"not":"array"}' },
    });
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() =>
      expect(screen.getByText(/args 必须是数组|args must be an array/i)).not.toBeNull(),
    );
    expect(devicesApi.postCommandBatch).not.toHaveBeenCalled();
  });

  test("rejects a non-integer delivery timeout", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    await userEvent.type(screen.getByLabelText(/投递超时|Delivery timeout/), "abc");
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() =>
      expect(screen.getByText(/正整数|positive integer/i)).not.toBeNull(),
    );
    expect(devicesApi.postCommandBatch).not.toHaveBeenCalled();
  });

  test("sends a valid command and reports the batch", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    fireEvent.change(screen.getByLabelText(/参数 args|Arguments/), {
      target: { value: '[{"delay_ms": 100}]' },
    });
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() =>
      expect(screen.getByText(/已入队|Queued|В очереди|У черзі/i)).not.toBeNull(),
    );
    expect(devicesApi.postCommandBatch).toHaveBeenCalledWith({
      device_ids: ["d1"],
      command: { cmd: "reboot", args: [{ delay_ms: 100 }] },
    });
  });

  test("reports the API error when enqueueing fails", async () => {
    devicesApi.postCommandBatch.mockRejectedValue(
      new Error("target_devices_not_found: missing"),
    );
    renderPanel();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() =>
      expect(screen.getByText(/target_devices_not_found/)).not.toBeNull(),
    );
  });
});
