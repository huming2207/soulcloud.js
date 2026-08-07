/**
 * RolloutCreateDialog tests: client-side validation and create flow.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/I18nContext";
import type { ReleaseSummary } from "../api/types";

const devicesApi = {
  fetchDevices: mock(async () => ({
    total: 2,
    devices: [
      { device_id: "d1", device_uid: "u1", assigned_id: "a1", auth_revoked: false, firmware: null },
      { device_id: "d2", device_uid: "u2", assigned_id: "a2", auth_revoked: false, firmware: null },
    ],
  })),
};
mock.module("../api/devices", () => devicesApi);

const firmwareApi = {
  fetchReleases: mock(async (): Promise<{ items: ReleaseSummary[]; next_cursor: string | null }> => ({ items: [], next_cursor: null })),
  fetchRelease: mock(async () => ({})),
  uploadArtifact: mock(async () => ({})),
  uploadRelease: mock(async () => ({})),
  downloadRelease: mock(async () => new Blob()),
  deployRelease: mock(async () => ({})),
  fetchOtaJob: mock(async () => ({})),
  fetchRollouts: mock(async () => ({ total: 0, rollouts: [] })),
  fetchRollout: mock(async () => ({})),
  createRollout: mock(async () => ({
    rollout_id: "r1",
    phases: [],
    job_id: null,
  })),
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

const { RolloutCreateDialog } = await import("./RolloutCreateDialog");

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
              element={<RolloutCreateDialog releaseId="rel-1" open onClose={() => {}} />}
            />
            <Route path="/rollouts/:rolloutId" element={<div>ROLLOUT-DETAIL</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function submitForm(): void {
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
}

async function selectDevices() {
  // open the device-pool Autocomplete, then click its first option
  const input = screen.getByLabelText(/目标设备池|Target device pool|Пул целевых|Пул цільових|Pool di dispositivi target/);
  await userEvent.click(input);
  const option = await screen.findByText(/a1 · u1/);
  await userEvent.click(option);
}

beforeEach(() => {
  firmwareApi.createRollout.mockClear();
  firmwareApi.createRollout.mockResolvedValue({ rollout_id: "r1", phases: [], job_id: null });
  localStorage.clear();
});

describe("RolloutCreateDialog validation", () => {
  test("auto strategy: rejects ratios that do not end at 1", async () => {
    renderDialog();
    await selectDevices();
    // default ratios 0.05/0.25/1.0; set the last one to 0.5
    const ratioInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    ).filter((el) => /ratio|比率|доля|частка|quota/i.test(el.getAttribute("aria-label") ?? ""));
    const last = ratioInputs[ratioInputs.length - 1]!;
    await userEvent.clear(last);
    await userEvent.type(last, "0.5");
    submitForm();
    await waitFor(() =>
      expect(
        screen.getByText(/最后一项比率必须为 1|last ratio must be 1|Последняя доля должна быть 1/i),
      ).not.toBeNull(),
    );
    expect(firmwareApi.createRollout).not.toHaveBeenCalled();
  });

  test("auto strategy: rejects a missing device pool", async () => {
    renderDialog();
    submitForm();
    await waitFor(() =>
      expect(
        screen.getByText(/请选择目标设备|select target devices|Выберите целевые устройства/i),
      ).not.toBeNull(),
    );
    expect(firmwareApi.createRollout).not.toHaveBeenCalled();
  });

  test("grouped strategy: rejects zero groups", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/自定义分组|Custom groups|Пользовательские группы/i));
    submitForm();
    await waitFor(() =>
      expect(
        screen.getByText(/至少需要一组设备|at least one group|Требуется хотя бы одна группа/i),
      ).not.toBeNull(),
    );
    expect(firmwareApi.createRollout).not.toHaveBeenCalled();
  });

  test("creates an auto rollout and navigates to its detail page", async () => {
    renderDialog();
    await selectDevices();
    submitForm();
    await waitFor(() => expect(screen.getByText("ROLLOUT-DETAIL")).not.toBeNull());
    expect(firmwareApi.createRollout).toHaveBeenCalledWith("rel-1", expect.objectContaining({
      strategy: "auto",
      ratios: [0.05, 0.25, 1],
      success_ratio: 0.9,
      min_sample: 10,
      manual_approval: false,
    }));
  });

  test("auto strategy: rejects non-ascending ratios", async () => {
    renderDialog();
    await selectDevices();
    const ratioInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    ).filter((el) => /ratio|比率|доля|частка|quota/i.test(el.getAttribute("aria-label") ?? ""));
    const second = ratioInputs[1]!;
    await userEvent.clear(second);
    await userEvent.type(second, "0.05"); // equal to the first -> not strictly ascending
    submitForm();
    await waitFor(() =>
      expect(
        screen.getByText(/比率必须严格递增|ratios must be strictly|Доли должны строго возрастать/i),
      ).not.toBeNull(),
    );
    expect(firmwareApi.createRollout).not.toHaveBeenCalled();
  });

  test("auto strategy: rejecting non-positive gating values", async () => {
    renderDialog();
    await selectDevices();
    const sample = screen.getByLabelText(/最小样本|Min sample|минимальная выборка/i);
    await userEvent.clear(sample);
    await userEvent.type(sample, "0");
    submitForm();
    await waitFor(() =>
      expect(
        screen.getByText(/必须是正数|must be a positive|должно быть положительным|має бути додатним|deve essere un numero positivo/i),
      ).not.toBeNull(),
    );
    expect(firmwareApi.createRollout).not.toHaveBeenCalled();
  });

  test("auto strategy: ratio rows can be added and removed", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /^添加$|Add$/i }));
    const ratioInputs = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter((el) =>
        /ratio|比率|доля|частка|quota/i.test(el.getAttribute("aria-label") ?? ""),
      );
    expect(ratioInputs()).toHaveLength(4); // default 3 + added
    await userEvent.click(screen.getAllByRole("button", { name: /删除比率|Delete ratio|Удалить долю|Видалити частку|Elimina percentuale/i })[0]!);
    expect(ratioInputs()).toHaveLength(3);
  });

  test("grouped strategy: creates with per-group device sets", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/自定义分组|Custom groups|Пользовательские группы/i));
    // group 1: pick d1
    const g1 = screen.getByLabelText(/第 1 组|Group 1|Группа 1/);
    await userEvent.click(g1);
    await userEvent.click(await screen.findByText(/a1 · u1/));
    // add group 2 and pick d2
    await userEvent.click(screen.getByRole("button", { name: /添加分组|Add group|Добавить группу/i }));
    const g2 = screen.getByLabelText(/第 2 组|Group 2|Группа 2/);
    await userEvent.click(g2);
    await userEvent.click(await screen.findByText(/a2 · u2/));
    submitForm();
    await waitFor(() => expect(screen.getByText("ROLLOUT-DETAIL")).not.toBeNull());
    expect(firmwareApi.createRollout).toHaveBeenCalledWith("rel-1",
      expect.objectContaining({
        strategy: "grouped",
        phases: [{ device_ids: ["d1"] }, { device_ids: ["d2"] }],
      }),
    );
  });

  test("grouped strategy: groups can be removed (first one stays)", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/自定义分组|Custom groups|Пользовательские группы/i));
    const deleteButtons = screen.getAllByRole("button", { name: /删除分组|Delete group|Удалить группу|Видалити групу|Elimina gruppo/i });
    expect(deleteButtons).toHaveLength(1);
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true); // single group cannot be removed
    await userEvent.click(screen.getByRole("button", { name: /添加分组|Add group|Добавить группу/i }));
    const afterAdd = screen.getAllByRole("button", { name: /删除分组|Delete group|Удалить группу|Видалити групу|Elimina gruppo/i });
    expect(afterAdd).toHaveLength(2);
    await userEvent.click(afterAdd[0]!);
    expect(
      screen.getAllByRole("button", { name: /删除分组|Delete group|Удалить группу|Видалити групу|Elimina gruppo/i }),
    ).toHaveLength(1);
  });

  test("from_release baseline and manual approval reach the request", async () => {
    firmwareApi.fetchReleases.mockResolvedValue({
      items: [
        { release_id: "rel-0", version: "v1", artifact_id: "art-0", bin_hash: "b0", bin_size: 1, created_at: "2026-08-01T00:00:00Z" },
        { release_id: "rel-1", version: "v2", artifact_id: "art-1", bin_hash: "b1", bin_size: 1, created_at: "2026-08-02T00:00:00Z" },
      ],
      next_cursor: null,
    });
    renderDialog();
    await selectDevices();
    // pick the baseline (current release is excluded from the list)
    const baseline = screen.getByLabelText(/回滚基线|Rollback baseline|Базовая линия|Базовий|Baseline/i);
    await userEvent.click(baseline);
    await userEvent.click(await screen.findByText(/v1 · rel-0/));
    // toggle manual approval
    await userEvent.click(screen.getByLabelText(/每阶段手动批准|manual approval|ручное одобрение/i));
    submitForm();
    await waitFor(() => expect(screen.getByText("ROLLOUT-DETAIL")).not.toBeNull());
    expect(firmwareApi.createRollout).toHaveBeenCalledWith("rel-1",
      expect.objectContaining({
        from_release_id: "rel-0",
        manual_approval: true,
      }),
    );
  });
});
