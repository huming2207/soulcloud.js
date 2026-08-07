/**
 * FirmwarePage tests: release/artifact tabs and upload dialog wiring.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { ReleaseListResponse, ArtifactListResponse } from "../api/types";

const firmwareApi = {
  fetchReleases: mock(
    async (): Promise<ReleaseListResponse> => ({ items: [], next_cursor: null }),
  ),
  fetchArtifacts: mock(
    async (): Promise<ArtifactListResponse> => ({ artifacts: [] }),
  ),
  uploadRelease: mock(async () => ({})),
  uploadArtifact: mock(async () => ({})),
  triggerReleaseDownload: mock(async () => {}),
  deployRelease: mock(async () => ({})),
  fetchOtaJob: mock(async () => ({})),
  fetchRollouts: mock(async () => ({ total: 0, rollouts: [] })),
  fetchRollout: mock(async () => ({})),
  createRollout: mock(async () => ({})),
  pauseRollout: mock(async () => {}),
  resumeRollout: mock(async () => {}),
  abortRollout: mock(async () => {}),
  rollbackRollout: mock(async () => ({})),
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

const { FirmwarePage } = await import("./FirmwarePage");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <FirmwarePage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  firmwareApi.fetchReleases.mockClear();
  firmwareApi.fetchReleases.mockResolvedValue({ items: [], next_cursor: null });
  firmwareApi.fetchArtifacts.mockClear();
  firmwareApi.fetchArtifacts.mockResolvedValue({ artifacts: [] });
});

describe("FirmwarePage", () => {
  test("renders releases with hash, size and artifact link", async () => {
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        {
          release_id: "r1",
          bin_hash: "aa".repeat(32),
          bin_size: 2048,
          version: "v2.0.0",
          artifact_id: "a1",
          created_at: "2026-08-06T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("v2.0.0")).not.toBeNull());
    expect(screen.getByText(/2\.0 KB|2048/)).not.toBeNull();
    expect(screen.getByText(/已关联|Linked|Привязан|Прив'язано/i)).not.toBeNull();
  });

  test("renders the ELF artifacts tab", async () => {
    firmwareApi.fetchArtifacts.mockResolvedValue({
      artifacts: [
        {
          artifact_id: "a1",
          build_id: "bb".repeat(32),
          version: "v1.0.0",
          elf_size: 4096,
          import_state: "imported",
          uploaded_at: "2026-08-06T00:00:00Z",
          dictionary_entries: 42,
        },
      ],
    });
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /ELF 构件|ELF Artifacts|ELF-артефакт/i }));
    await waitFor(() => expect(screen.getByText("v1.0.0")).not.toBeNull());
    expect(screen.getByText("42")).not.toBeNull();
  });

  test("opens the upload dialog from the releases tab", async () => {
    renderPage();
    await userEvent.click(
      screen.getByRole("button", { name: /上传发布|Upload Release|Загрузить релиз/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/bin 文件|bin file|Файл bin/i)).not.toBeNull(),
    );
  });

  test("shows the empty releases state", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/暂无发布|No releases|Релизов нет|Релизів немає/i)).not.toBeNull(),
    );
  });

  test("a failed releases load shows the error with a retry action, not the empty state", async () => {
    firmwareApi.fetchReleases.mockRejectedValueOnce(new Error("network down"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/network down/)).not.toBeNull());
    // the empty-state hint must NOT appear (a failure must not look like an empty project)
    expect(screen.queryByText(/暂无发布|No releases|Релизов нет|Релизів немає/i)).toBeNull();
    // retry re-runs the query and recovers
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        {
          release_id: "r1",
          bin_hash: "aa".repeat(32),
          bin_size: 1024,
          version: "v2.1.0",
          artifact_id: null,
          created_at: "2026-08-06T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    const retry = await screen.findByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i });
    retry.click();
    await waitFor(() => expect(screen.getByText("v2.1.0")).not.toBeNull());
    expect(firmwareApi.fetchReleases.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("a failed artifacts load shows the error with a retry action, not the empty state", async () => {
    firmwareApi.fetchArtifacts.mockRejectedValueOnce(new Error("artifacts down"));
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: /ELF 构件|ELF Artifacts|ELF-артефакт/i }));
    await waitFor(() => expect(screen.getByText(/artifacts down/)).not.toBeNull());
    expect(screen.queryByText(/暂无构件|No artifacts|Артефактов нет/i)).toBeNull();
    // retry re-runs the query and recovers
    firmwareApi.fetchArtifacts.mockResolvedValue({
      artifacts: [
        {
          artifact_id: "a1",
          build_id: "bb".repeat(32),
          version: "v3.0.0",
          elf_size: 2048,
          import_state: "imported",
          uploaded_at: "2026-08-06T00:00:00Z",
          dictionary_entries: 7,
        },
      ],
    });
    const retry = await screen.findByRole("button", { name: /重试|Retry|Повторить|Повторити|Riprova/i });
    retry.click();
    await waitFor(() => expect(screen.getByText("v3.0.0")).not.toBeNull());
    expect(firmwareApi.fetchArtifacts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FirmwarePage size formatting and download", () => {
  test("formats small and large bin sizes (B and MB branches)", async () => {
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        {
          release_id: "r-small",
          bin_hash: "a1".repeat(32),
          bin_size: 512,
          version: "tiny",
          artifact_id: null,
          created_at: "2026-08-06T00:00:00Z",
        },
        {
          release_id: "r-big",
          bin_hash: "b2".repeat(32),
          bin_size: 2 * 1024 * 1024,
          version: "big",
          artifact_id: null,
          created_at: "2026-08-06T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("tiny")).not.toBeNull());
    expect(screen.getByText("512 B")).not.toBeNull();
    expect(screen.getByText("2.0 MB")).not.toBeNull();
  });

  test("downloads the bin with a versioned filename", async () => {
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        {
          release_id: "r1",
          bin_hash: "aa".repeat(32),
          bin_size: 1024,
          version: "v9.9.9",
          artifact_id: null,
          created_at: "2026-08-06T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("v9.9.9")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /下载 bin|Download bin/i }));
    await waitFor(() =>
      expect(firmwareApi.triggerReleaseDownload).toHaveBeenCalledWith(
        "r1",
        "release-v9.9.9.bin",
      ),
    );
  });

  test("shows an error when the download fails", async () => {
    firmwareApi.triggerReleaseDownload.mockRejectedValue(new Error("download failed"));
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        {
          release_id: "r1",
          bin_hash: "aa".repeat(32),
          bin_size: 1024,
          version: "v1",
          artifact_id: null,
          created_at: "2026-08-06T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("v1")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /下载 bin|Download bin/i }));
    await waitFor(() => expect(screen.getByText("download failed")).not.toBeNull());
  });
});
