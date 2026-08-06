/**
 * RolloutDetailPage tests: per-state action buttons and phase stepper.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { RolloutDetail } from "../api/types";

const firmwareApi = {
  fetchRollout: mock(async (): Promise<RolloutDetail> => rolloutFixture),
  pauseRollout: mock(async () => {}),
  resumeRollout: mock(async () => {}),
  abortRollout: mock(async () => {}),
  rollbackRollout: mock(async () => ({ rollback_job_id: null, target_devices: 0 })),
};
mock.module("../api/firmware", () => firmwareApi);

const { RolloutDetailPage } = await import("./RolloutDetailPage");

const rolloutFixture: RolloutDetail = {
  rollout_id: "r1",
  release_id: "rel-1",
  from_release_id: "rel-0",
  state: "running",
  strategy: "auto",
  success_ratio: 0.9,
  min_sample: 10,
  phase_timeout_hours: 24,
  stuck_hours: 6,
  manual_approval: false,
  rollback_job_id: null,
  created_at: "2026-08-06T00:00:00Z",
  pool_size: 4,
  phases: [
    {
      index: 1,
      ratio: 0.5,
      group_id: null,
      state: "completed",
      target_count: 2,
      job_id: "j1",
      activated_at: "2026-08-06T00:00:00Z",
      completed_at: "2026-08-06T01:00:00Z",
      summary: { completed: 2 },
    },
    {
      index: 2,
      ratio: 1.0,
      group_id: null,
      state: "active",
      target_count: 2,
      job_id: "j2",
      activated_at: "2026-08-06T01:00:00Z",
      completed_at: null,
      summary: { pending: 2 },
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/rollouts/r1"]}>
          <Routes>
            <Route path="/rollouts/:rolloutId" element={<RolloutDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  firmwareApi.fetchRollout.mockClear();
  firmwareApi.fetchRollout.mockResolvedValue(rolloutFixture);
  firmwareApi.pauseRollout.mockClear();
  firmwareApi.abortRollout.mockClear();
});

describe("RolloutDetailPage", () => {
  test("running rollout: pause and abort enabled, resume/rollback disabled", async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /暂停|Pause|Пауза/i }),
      ).not.toBeNull(),
    );
    const pause = screen.getByRole("button", { name: /暂停|Pause|Пауза/i }) as HTMLButtonElement;
    const resume = screen.getByRole("button", { name: /恢复|Resume|Продолжить/i }) as HTMLButtonElement;
    const abort = screen.getByRole("button", { name: /中止|Abort|Прервать|Перервати/i }) as HTMLButtonElement;
    const rollback = screen.getByRole("button", { name: /回滚|Rollback|Откат|Відкат/i }) as HTMLButtonElement;
    expect(pause.disabled).toBe(false);
    expect(abort.disabled).toBe(false);
    expect(resume.disabled).toBe(true);
    expect(rollback.disabled).toBe(true);
  });

  test("pausing calls the API and refreshes", async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /暂停|Pause|Пауза/i }),
      ).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /暂停|Pause|Пауза/i }));
    await waitFor(() => expect(firmwareApi.pauseRollout).toHaveBeenCalledWith("r1"));
  });

  test("paused rollout enables resume", async () => {
    firmwareApi.fetchRollout.mockResolvedValue({
      ...rolloutFixture,
      state: "paused",
    });
    renderPage();
    await waitFor(() => {
      const resume = screen.getByRole("button", {
        name: /恢复|Resume|Продолжить/i,
      }) as HTMLButtonElement;
      expect(resume.disabled).toBe(false);
    });
  });

  test("renders the phase stepper with per-phase summaries", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/已完成|Completed/i).length).toBeGreaterThan(0),
    );
    // phase 1 summary chip: completed 2
    expect(screen.getByText(/已完成 2|Completed 2/i)).not.toBeNull();
  });

  test("shows an error banner when an action fails", async () => {
    firmwareApi.pauseRollout.mockRejectedValue(
      new Error("wrong_state: rollout is not running"),
    );
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /暂停|Pause|Пауза/i }),
      ).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: /暂停|Pause|Пауза/i }));
    await waitFor(() => expect(screen.getByText(/wrong_state/)).not.toBeNull());
  });
});
