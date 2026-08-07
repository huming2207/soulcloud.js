/**
 * BindFirmwareDialog tests: artifact picker and bind flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { ArtifactListResponse } from "../api/types";

const firmwareApi = {
  fetchArtifacts: mock(
    async (): Promise<ArtifactListResponse> => ({ artifacts: [] }),
  ),
};
mock.module("../api/firmware", () => firmwareApi);

const devicesApi = {
  bindFirmwareState: mock(async () => ({
    device_id: "d1",
    artifact_id: "a1",
    backfilled_events: 4,
  })),
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

const { BindFirmwareDialog } = await import("./BindFirmwareDialog");

function renderDialog(onBound = mock(() => {})) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BindFirmwareDialog deviceId="d1" open onClose={() => {}} onBound={onBound} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devicesApi.bindFirmwareState.mockClear();
  devicesApi.bindFirmwareState.mockResolvedValue({
    device_id: "d1",
    artifact_id: "a1",
    backfilled_events: 4,
  });
});

describe("BindFirmwareDialog", () => {
  test("disables submit until an artifact is chosen", async () => {
    firmwareApi.fetchArtifacts.mockResolvedValue({
      artifacts: [
        {
          artifact_id: "a1",
          build_id: "bb".repeat(32),
          version: "v1.2.0",
          elf_size: 100,
          import_state: "imported",
          uploaded_at: "2026-08-06T00:00:00Z",
          dictionary_entries: 10,
        },
      ],
    });
    renderDialog();
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: /绑定|Bind|Привязать|Привязати/i,
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  test("binds the selected artifact and reports backfilled events", async () => {
    const onBound = mock(() => {});
    firmwareApi.fetchArtifacts.mockResolvedValue({
      artifacts: [
        {
          artifact_id: "a1",
          build_id: "bb".repeat(32),
          version: "v1.2.0",
          elf_size: 100,
          import_state: "imported",
          uploaded_at: "2026-08-06T00:00:00Z",
          dictionary_entries: 10,
        },
      ],
    });
    renderDialog(onBound);
    await userEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByText(/v1\.2\.0/);
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /绑定|Bind|Привязати/i }));
    await waitFor(() =>
      expect(screen.getByText(/回填|backfilled|обработано событий/i)).not.toBeNull(),
    );
    expect(devicesApi.bindFirmwareState).toHaveBeenCalledWith("d1", "a1");
    expect(onBound).toHaveBeenCalled();
  });

  test("surfaces bind errors", async () => {
    devicesApi.bindFirmwareState.mockRejectedValue(
      new Error("artifact_project_mismatch: belongs to a different project"),
    );
    firmwareApi.fetchArtifacts.mockResolvedValue({
      artifacts: [
        {
          artifact_id: "a1",
          build_id: "bb".repeat(32),
          version: "v1.2.0",
          elf_size: 100,
          import_state: "imported",
          uploaded_at: "2026-08-06T00:00:00Z",
          dictionary_entries: 10,
        },
      ],
    });
    renderDialog();
    await userEvent.click(screen.getByRole("combobox"));
    const option = await screen.findByText(/v1\.2\.0/);
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /绑定|Bind|Привязати/i }));
    await waitFor(() =>
      expect(screen.getByText(/artifact_project_mismatch/)).not.toBeNull(),
    );
  });
});
