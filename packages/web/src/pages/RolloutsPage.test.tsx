/**
 * RolloutsPage tests: list rendering with progress bars.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { RolloutListResponse } from "../api/types";

const firmwareApi = {
  fetchRollouts: mock(
    async (): Promise<RolloutListResponse> => ({ total: 0, rollouts: [] }),
  ),
  fetchOtaJob: mock(async () => ({})),
  fetchReleases: mock(async () => ({ items: [], next_cursor: null })),
  fetchRelease: mock(async () => ({})),
  fetchArtifacts: mock(async () => ({ artifacts: [] })),
  fetchRollout: mock(async () => ({})),
  uploadRelease: mock(async () => ({})),
  uploadArtifact: mock(async () => ({})),
  deployRelease: mock(async () => ({})),
  createRollout: mock(async () => ({})),
  pauseRollout: mock(async () => {}),
  resumeRollout: mock(async () => {}),
  abortRollout: mock(async () => {}),
  rollbackRollout: mock(async () => ({})),
  triggerReleaseDownload: mock(async () => {}),
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

const { RolloutsPage } = await import("./RolloutsPage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/rollouts"]}>
          <Routes>
            <Route path="/rollouts" element={<RolloutsPage />} />
            <Route path="/rollouts/:rolloutId" element={<div>ROLLOUT-DETAIL</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  firmwareApi.fetchRollouts.mockClear();
  firmwareApi.fetchRollouts.mockResolvedValue({ total: 0, rollouts: [] });
});

describe("RolloutsPage", () => {
  test("renders rollout rows with strategy, state and progress", async () => {
    firmwareApi.fetchRollouts.mockResolvedValue({
      total: 1,
      rollouts: [
        {
          rollout_id: "r1",
          release_id: "rel-1",
          from_release_id: null,
          state: "running",
          strategy: "auto",
          manual_approval: false,
          created_at: "2026-08-06T00:00:00Z",
          pool_size: 10,
          progress: { completed: 4, failed: 1 },
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/自动分批|Auto|Авто/i)).not.toBeNull(),
    );
    expect(screen.getByText(/进行中|Running|Выполняется/i)).not.toBeNull();
    // progress text "5/10"
    expect(screen.getByText("5/10")).not.toBeNull();
  });

  test("renders the empty state", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/暂无升级|No rollouts|Развёртываний нет|Розгортань немає|Nessuna distribuzione/i)).not.toBeNull(),
    );
  });

  test("a failed load shows the error with a retry action, not the empty state", async () => {
    firmwareApi.fetchRollouts.mockRejectedValueOnce(new Error("rollouts down"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/rollouts down/)).not.toBeNull());
    // the empty-state hint must NOT appear (a failure must not look like an empty project)
    expect(screen.queryByText(/暂无升级|No rollouts|Развёртываний нет|Розгортань немає|Nessuna distribuzione/i)).toBeNull();
    // retry re-runs the query and recovers
    firmwareApi.fetchRollouts.mockResolvedValue({
      total: 1,
      rollouts: [
        {
          rollout_id: "r2",
          release_id: "rel-2",
          from_release_id: null,
          state: "completed",
          strategy: "auto",
          manual_approval: false,
          created_at: "2026-08-06T00:00:00Z",
          pool_size: 5,
          progress: { completed: 5, failed: 0 },
        },
      ],
    });
    const retry = await screen.findByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i });
    retry.click();
    await waitFor(() => expect(screen.getByText("5/5")).not.toBeNull());
    expect(firmwareApi.fetchRollouts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
