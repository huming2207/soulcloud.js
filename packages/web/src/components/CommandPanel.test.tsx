/**
 * CommandPanel tests: args JSON validation and the enqueue flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const commandStreamApi = {
  useCommandStream: mock<(batchId?: string, opts?: { onUpdate?: () => void }) => "idle">(
    () => "idle",
  ),
};
mock.module("../api/commandStream", () => commandStreamApi);

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
  devicesApi.fetchDeviceCommands.mockClear();
  devicesApi.fetchDeviceCommands.mockResolvedValue({ commands: [], next_cursor: null });
  devicesApi.fetchCommandBatch.mockClear();
  devicesApi.fetchCommandBatch.mockResolvedValue({
    batch_id: "b1",
    device_count: 1,
    created_at: "2026-08-06T00:00:00Z",
    summary: { device_completed: 1 },
    commands: [],
  });
  commandStreamApi.useCommandStream.mockClear();
});

describe("CommandHistory", () => {
  const rows = [
    {
      command_id: "c1",
      batch_id: "batch-12345678-0000-0000-0000-000000000000",
      sequence: "1",
      command: { cmd: "reboot", args: [{ enabled: true }] },
      state: "device_completed",
      result_code: 0,
      result: { code: 0, payload: { ok: true } },
      created_at: "2026-08-06T00:00:00Z",
      delivery_expires_at: null,
      device_completed_at: null,
    },
    {
      command_id: "c2",
      batch_id: "batch-87654321-0000-0000-0000-000000000000",
      sequence: "2",
      command: { cmd: "get_status", args: null },
      state: "delivery_failed",
      result_code: -1,
      result: { code: -1, payload: "boom" },
      created_at: "2026-08-06T00:01:00Z",
      delivery_expires_at: null,
      device_completed_at: null,
    },
  ] as const;

  test("renders command name, args, state chip, result and batch link", async () => {
    devicesApi.fetchDeviceCommands.mockResolvedValue({
      commands: [...rows],
      next_cursor: null,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("reboot")).not.toBeNull());
    // args formatted as JSON under the command name
    expect(screen.getByText(/\[\{"enabled":true\}\]/)).not.toBeNull();
    // state chip
    expect(screen.getByText(/Completed|已完成/i)).not.toBeNull();
    // success result: code=0 in green
    expect(screen.getByText(/code=0/)).not.toBeNull();
    // failure row: state chip + red result
    expect(screen.getByText(/Delivery failed|投递失败/i)).not.toBeNull();
    expect(screen.getByText(/code=-1/)).not.toBeNull();
    // batch links show the first 8 chars
    expect(screen.getByText(/batch-12/)).not.toBeNull();
    expect(screen.getByText(/batch-87/)).not.toBeNull();
  });

  test("an unknown command state renders the state.unknown fallback", async () => {
    devicesApi.fetchDeviceCommands.mockResolvedValue({
      commands: [
        {
          command_id: "cX",
          batch_id: "batch-00000000-0000-0000-0000-000000000000",
          sequence: "9",
          command: { cmd: "future_cmd", args: null },
          // a state the frontend has never seen (backend added it later);
          // cast through never to model the runtime out-of-enum value
          state: "super_state" as never,
          result_code: null,
          result: null,
          created_at: "2026-08-06T00:00:00Z",
          delivery_expires_at: null,
          device_completed_at: null,
        },
      ],
      next_cursor: null,
    });
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText(/Unknown|未知|Неизвестно|Невідомо|Sconosciuto/i),
      ).not.toBeNull(),
    );
    // the command itself still renders
    expect(screen.getByText("future_cmd")).not.toBeNull();
  });

  test("shows the empty hint when there are no commands", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/No commands|暂无命令/)).not.toBeNull(),
    );
  });

  test("load earlier fetches with the cursor", async () => {
    devicesApi.fetchDeviceCommands.mockResolvedValue({
      commands: [...rows],
      next_cursor: "cursor-abc",
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Load earlier|加载更早/i })).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /Load earlier|加载更早/i }));
    await waitFor(() =>
      expect(devicesApi.fetchDeviceCommands).toHaveBeenCalledWith("d1", {
        limit: 50,
        cursor: "cursor-abc",
      }),
    );
  });

  test("back to latest clears the cursor", async () => {
    // first page has a cursor -> user goes back to page 0
    devicesApi.fetchDeviceCommands
      .mockResolvedValueOnce({ commands: [...rows], next_cursor: "cursor-abc" })
      .mockResolvedValue({ commands: [...rows], next_cursor: null });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Load earlier|加载更早/i })).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /Load earlier|加载更早/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Back to latest|回到最新/i })).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /Back to latest|回到最新/i }));
    await waitFor(() =>
      expect(devicesApi.fetchDeviceCommands).toHaveBeenLastCalledWith("d1", {
        limit: 50,
        cursor: undefined,
      }),
    );
  });

  test("clicking a batch link opens the batch dialog", async () => {
    devicesApi.fetchDeviceCommands.mockResolvedValue({
      commands: [...rows],
      next_cursor: null,
    });
    devicesApi.fetchCommandBatch.mockResolvedValue({
      batch_id: "batch-12345678-0000-0000-0000-000000000000",
      device_count: 2,
      created_at: "2026-08-06T00:00:00Z",
      summary: { device_completed: 1, queued: 1 },
      commands: [],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/batch-12/)).not.toBeNull());
    await userEvent.click(screen.getByText(/batch-12/));
    await waitFor(() =>
      expect(devicesApi.fetchCommandBatch).toHaveBeenCalledWith(
        "batch-12345678-0000-0000-0000-000000000000",
      ),
    );
    // dialog opens with its summary chips
    await waitFor(() =>
      expect(screen.getByText(/Batch batch-12345678-0000-0000-0000-000000000000|批次/)).not.toBeNull(),
    );
    expect(screen.getByText(/Completed 1|已完成 1/)).not.toBeNull();
    expect(screen.getByText(/Queued 1|排队中 1/)).not.toBeNull();
    // close button calls onClose (dialog unmounts)
    await userEvent.click(screen.getByRole("button", { name: /Close|关闭/ }));
    await waitFor(() =>
      expect(screen.queryByText(/Batch batch-12345678-0000-0000-0000-000000000000|批次/)).toBeNull(),
    );
  });

  test("batch dialog renders per-device command rows", async () => {
    devicesApi.fetchDeviceCommands.mockResolvedValue({
      commands: [...rows],
      next_cursor: null,
    });
    devicesApi.fetchCommandBatch.mockResolvedValue({
      batch_id: "batch-12345678-0000-0000-0000-000000000000",
      device_count: 1,
      created_at: "2026-08-06T00:00:00Z",
      summary: { device_completed: 1 },
      commands: [
        {
          command_id: "c1",
          batch_id: "batch-12345678-0000-0000-0000-000000000000",
          sequence: "1",
          command: { cmd: "reboot", args: null },
          state: "device_completed",
          result_code: 0,
          result: { code: 0, payload: null },
          created_at: "2026-08-06T00:00:00Z",
          delivery_expires_at: null,
          device_completed_at: null,
          device_id: "d1",
          device_uid: "uid-1",
        },
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/batch-12/)).not.toBeNull());
    await userEvent.click(screen.getByText(/batch-12/));
    // the batch dialog lists the device and its command
    await waitFor(() => expect(screen.getAllByText("uid-1").length).toBeGreaterThan(0));
    expect(screen.getAllByText("reboot").length).toBeGreaterThan(0);
  });
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

  test("ArrowUp recalls the previous command from history", async () => {
    // seed history for device d1 (the panel's device)
    localStorage.setItem(
      "soulcloud.cmdhistory.d1",
      JSON.stringify(["status", "reboot"]),
    );
    renderPanel();
    const input = screen.getByLabelText(/命令名|Command name/) as HTMLInputElement;
    await userEvent.type(input, "x");
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(input.value).toBe("reboot"));
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(input.value).toBe("status"));
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(input.value).toBe("reboot"));
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(input.value).toBe("x")); // draft restored
  });

  test("a successful enqueue is recorded into history", async () => {
    localStorage.clear();
    renderPanel();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() => expect(devicesApi.postCommandBatch).toHaveBeenCalled());
    const stored = JSON.parse(
      localStorage.getItem("soulcloud.cmdhistory.d1") ?? "[]",
    );
    expect(stored).toEqual(["reboot"]);
  });
});

describe("CommandPanel stream", () => {
  test("subscribes to the submitted batch and refreshes history on update", async () => {
    renderPanel();
    // no batch submitted yet -> the stream stays closed (undefined batch id)
    expect(commandStreamApi.useCommandStream.mock.calls.at(-1)?.[0]).toBeUndefined();
    await userEvent.type(screen.getByLabelText(/命令名|Command name/), "reboot");
    await userEvent.click(screen.getByRole("button", { name: /发送到设备|Send to device/i }));
    await waitFor(() => expect(devicesApi.postCommandBatch).toHaveBeenCalled());
    // after a successful enqueue the hook receives the returned batch id
    await waitFor(() =>
      expect(commandStreamApi.useCommandStream.mock.calls.at(-1)?.[0]).toBe("b1"),
    );
    const before = devicesApi.fetchDeviceCommands.mock.calls.length;
    act(() => {
      commandStreamApi.useCommandStream.mock.calls.at(-1)?.[1]?.onUpdate?.();
    });
    // the pushed batch update invalidates the history query -> refetch
    await waitFor(() =>
      expect(devicesApi.fetchDeviceCommands.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
