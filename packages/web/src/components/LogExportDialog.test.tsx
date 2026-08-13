/**
 * Log export dialog tests: renders the time-range form, calls the export
 * endpoint with the access token, triggers the browser download on success
 * and surfaces failures without closing.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";
import { setAccessToken } from "../api/http";
import { LogExportDialog } from "./LogExportDialog";

afterEach(() => {
  mock.restore();
  setAccessToken(null);
});

function renderDialog() {
  return render(
    <I18nProvider>
      <LogExportDialog
        deviceId="dev-1"
        deviceUid="demo-device-lan-42"
        open
        onClose={mock(() => {})}
      />
    </I18nProvider>,
  );
}

describe("LogExportDialog", () => {
  test("renders the time range form", () => {
    renderDialog();
    expect(screen.getByLabelText(/开始时间|From|С|Від|Da/)).toBeTruthy();
    expect(screen.getByLabelText(/结束时间|To|По|До|A/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /下载|Download|Скачать|Завантажити|Scarica/ })).toBeTruthy();
  });

  test("downloads the streamed CSV with the access token", async () => {
    const fetchMock = mock(async () =>
      new Response(new Blob(["received_at,x\n", "2026-08-13T00:00:00Z,1\n"]), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setAccessToken("tok-123");

    // capture anchor clicks (happy-dom has no real download)
    const clickMock = mock(() => {});
    const anchor = { href: "", download: "", click: clickMock };
    const createAnchor = mock(() => anchor);
    const createUrl = mock(() => "blob:mock");
    const revokeUrl = mock(() => {});
    const origCreate = document.createElement.bind(document);
    document.createElement = ((tag: string) =>
      tag === "a" ? (anchor as unknown as HTMLElement) : origCreate(tag)) as typeof document.createElement;
    const origCreateObjUrl = URL.createObjectURL;
    URL.createObjectURL = createUrl;
    const origRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = revokeUrl;

    try {
      renderDialog();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /下载|Download|Скачать|Завантажити|Scarica/ }));
      await waitFor(() => expect(clickMock).toHaveBeenCalled());
      expect(anchor.download).toBe("demo-device-lan-42-logs.csv");
      expect(fetchMock).toHaveBeenCalled();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/v1/devices/dev-1/logs/export?from=");
      expect(url).toContain("&to=");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
      expect(revokeUrl).toHaveBeenCalled();
    } finally {
      URL.createObjectURL = origCreateObjUrl;
      URL.revokeObjectURL = origRevoke;
      document.createElement = origCreate;
    }
  });

  test("shows the error hint and stays open on a failed export", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    setAccessToken("tok-123");
    const onClose = mock(() => {});
    render(
      <I18nProvider>
        <LogExportDialog deviceId="dev-1" deviceUid="uid" open onClose={onClose} />
      </I18nProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /下载|Download|Скачать|Завантажити|Scarica/ }));
    await waitFor(() =>
      expect(
        screen.getByText(/导出失败|Export failed|Ошибка экспорта|Помилка експорту|Esportazione non riuscita/),
      ).toBeTruthy(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
