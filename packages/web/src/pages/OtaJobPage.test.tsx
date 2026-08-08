/**
 * OtaJobPage tests: target table rendering with state chips.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { OtaJobDetail } from "../api/types";
import type { OtaStreamUpdate } from "../api/otaStream";

const firmwareApi = {
  fetchOtaJob: mock(async (): Promise<OtaJobDetail> => ({
    job_id: "j1",
    release_id: "rel-1",
    created_at: "2026-08-06T00:00:00Z",
    targets: [],
    summary: {},
  })),
};
mock.module("../api/firmware", () => firmwareApi);

const otaStreamApi = {
  useOtaStream: mock<(jobId?: string, opts?: { onUpdate?: (update: OtaStreamUpdate) => void }) => "idle">(
    () => "idle",
  ),
};
mock.module("../api/otaStream", () => otaStreamApi);

const { OtaJobPage } = await import("./OtaJobPage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/ota-jobs/j1"]}>
          <Routes>
            <Route path="/ota-jobs/:jobId" element={<OtaJobPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  firmwareApi.fetchOtaJob.mockClear();
  otaStreamApi.useOtaStream.mockClear();
});

describe("OtaJobPage", () => {
  test("renders target rows with state, result and firmware", async () => {
    firmwareApi.fetchOtaJob.mockResolvedValue({
      job_id: "j1",
      release_id: "rel-1",
      created_at: "2026-08-06T00:00:00Z",
      targets: [
        {
          device_id: "d1",
          device_uid: "uid-1",
          state: "completed",
          delivered_at: "2026-08-06T00:00:00Z",
          confirmed_at: "2026-08-06T00:05:00Z",
          result_code: 0,
          result_message: null,
          current_fw: "aa".repeat(32),
        },
        {
          device_id: "d2",
          device_uid: "uid-2",
          state: "failed",
          delivered_at: null,
          confirmed_at: null,
          result_code: -5,
          result_message: "ack timeout",
          current_fw: null,
        },
      ],
      summary: { completed: 1, failed: 1 },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("uid-1")).not.toBeNull());
    expect(screen.getByText("uid-2")).not.toBeNull();
    expect(screen.getAllByText(/已完成|Completed|Завершено/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/失败|Failed|Сбой|Збій/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/成功|Success|Успех|Успіх/i)).not.toBeNull();
  });

  test("shows the empty targets state", async () => {
    firmwareApi.fetchOtaJob.mockResolvedValue({
      job_id: "j1",
      release_id: "rel-1",
      created_at: "2026-08-06T00:00:00Z",
      targets: [],
      summary: {},
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/无目标设备|No target devices|Целевых устройств нет/i),
      ).not.toBeNull(),
    );
  });

  test("a failed load shows the error with a retry action, not the empty targets state", async () => {
    firmwareApi.fetchOtaJob.mockRejectedValueOnce(new Error("job down"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/job down/)).not.toBeNull());
    // the empty targets hint must NOT appear (a failure must not look like an empty job)
    expect(screen.queryByText(/无目标设备|No target devices|Целевых устройств нет/i)).toBeNull();
    // retry re-runs the query and recovers
    firmwareApi.fetchOtaJob.mockResolvedValue({
      job_id: "j1",
      release_id: "rel-1",
      created_at: "2026-08-06T00:00:00Z",
      targets: [
        {
          device_id: "d1",
          device_uid: "uid-1",
          state: "pending",
          delivered_at: null,
          confirmed_at: null,
          result_code: null,
          result_message: null,
          current_fw: null,
        },
      ],
      summary: { pending: 1 },
    });
    const retry = await screen.findByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i });
    retry.click();
    await waitFor(() => expect(screen.getByText("uid-1")).not.toBeNull());
    expect(firmwareApi.fetchOtaJob.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("OtaJobPage stream", () => {
  const emptyJob: OtaJobDetail = {
    job_id: "j1",
    release_id: "rel-1",
    created_at: "2026-08-06T00:00:00Z",
    targets: [],
    summary: {},
  };

  test("subscribes to the job stream with the route job id", async () => {
    firmwareApi.fetchOtaJob.mockResolvedValue(emptyJob);
    renderPage();
    await waitFor(() => expect(otaStreamApi.useOtaStream).toHaveBeenCalled());
    expect(otaStreamApi.useOtaStream.mock.calls.at(-1)?.[0]).toBe("j1");
  });

  test("a stream update replaces the cached job so the UI renders the new state", async () => {
    firmwareApi.fetchOtaJob.mockResolvedValue(emptyJob);
    renderPage();
    // initial REST load: empty job
    await waitFor(() =>
      expect(
        screen.getByText(/无目标设备|No target devices|Целевых устройств нет/i),
      ).not.toBeNull(),
    );
    // simulate a pushed frame: job completed with one target
    const onUpdate = otaStreamApi.useOtaStream.mock.calls.at(-1)?.[1]?.onUpdate;
    expect(onUpdate).toBeDefined();
    act(() => {
      onUpdate?.({
        job_id: "j1",
        release_id: "rel-1",
        created_at: "2026-08-06T00:00:00Z",
        state: "completed",
        targets: [
          {
            device_id: "d1",
            device_uid: "uid-1",
            state: "completed",
            delivered_at: "2026-08-06T00:00:00Z",
            confirmed_at: "2026-08-06T00:05:00Z",
            result_code: 0,
            result_message: null,
            current_fw: null,
          },
        ],
        summary: { completed: 1 },
      });
    });
    await waitFor(() => expect(screen.getByText("uid-1")).not.toBeNull());
    expect(screen.getByText(/Completed 1|已完成 1/)).not.toBeNull();
  });
});
