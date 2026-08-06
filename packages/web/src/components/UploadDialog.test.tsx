/**
 * UploadDialog tests: file validation and upload feedback.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";

const firmwareApi = {
  uploadArtifact: mock(async () => ({
    artifact_id: "a1",
    build_id: "b1",
    import_state: "imported",
    tag_count: 3,
    format_count: 2,
    backfilled_events: 5,
  })),
  uploadRelease: mock(async () => ({
    release_id: "r1",
    bin_hash: "h1",
    bin_size: 1024,
    artifact_id: "a1",
    version: "v1",
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

const { UploadDialog } = await import("./UploadDialog");

function makeFile(name: string, size = 100): File {
  return new File([new Uint8Array(size)], name);
}

function renderDialog(kind: "artifact" | "release", onUploaded = mock(() => {})) {
  return render(
    <I18nProvider>
      <UploadDialog kind={kind} open onClose={() => {}} onUploaded={onUploaded} />
    </I18nProvider>,
  );
}

function submitForm(): void {
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
}

beforeEach(() => {
  firmwareApi.uploadArtifact.mockClear();
  firmwareApi.uploadRelease.mockClear();
});

describe("UploadDialog (artifact)", () => {
  test("requires an ELF file", async () => {
    renderDialog("artifact");
    submitForm();
    await waitFor(() =>
      expect(screen.getByText(/请选择 ELF|choose an ELF|Выберите ELF|Виберіть ELF|Scegli un file ELF/i)).not.toBeNull(),
    );
    expect(firmwareApi.uploadArtifact).not.toHaveBeenCalled();
  });

  test("uploads the ELF and reports dictionary counts", async () => {
    const onUploaded = mock(() => {});
    renderDialog("artifact", onUploaded);
    // the bin input is always in the DOM (hidden); target the elf input by accept
    const elfInput = document.querySelector<HTMLInputElement>('input[accept=".elf"]')!;
    await userEvent.upload(elfInput, makeFile("fw.elf"));
    submitForm();
    await waitFor(() =>
      expect(screen.getByText(/导入完成|Import complete|Импорт завершён|Імпорт завершено/i)).not.toBeNull(),
    );
    expect(firmwareApi.uploadArtifact).toHaveBeenCalledWith(
      "p1",
      expect.any(File),
      undefined,
    );
    expect(onUploaded).toHaveBeenCalled();
  });
});

describe("UploadDialog (release)", () => {
  test("requires a bin file", async () => {
    renderDialog("release");
    submitForm();
    await waitFor(() =>
      expect(screen.getByText(/请选择 bin|choose a bin|Выберите bin|Виберіть bin|Scegli un file bin/i)).not.toBeNull(),
    );
    expect(firmwareApi.uploadRelease).not.toHaveBeenCalled();
  });

  test("uploads bin + elf and reports the release", async () => {
    renderDialog("release");
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(inputs[0]!, makeFile("fw.bin"));
    await userEvent.upload(inputs[1]!, makeFile("fw.elf"));
    submitForm();
    await waitFor(() =>
      expect(screen.getByText(/发布成功|Release uploaded|Релиз загружен|Релиз завантажено/i)).not.toBeNull(),
    );
    expect(firmwareApi.uploadRelease).toHaveBeenCalledWith(
      "p1",
      { bin: expect.any(File), elf: expect.any(File) },
      undefined,
    );
  });
});
