/**
 * AppLayout tests: navigation, language menu, project selector, logout.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { I18nProvider } from "../i18n/I18nContext";

const authCtx = {
  status: "authed" as const,
  user: { userId: "u1", username: "tester" },
  login: mock(async () => {}),
  register: mock(async () => {}),
  logout: mock(async () => {}),
};
mock.module("../auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => authCtx,
}));

const projectCtx = {
  projects: [
    { project_id: "p1", name: "Alpha", device_count: 2 },
    { project_id: "p2", name: "Beta", device_count: 5 },
  ],
  projectId: "p1",
  project: { project_id: "p1", name: "Alpha", device_count: 2 },
  setProjectId: mock(() => {}),
};
mock.module("./ProjectContext", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => children,
  useProject: () => projectCtx,
}));

const { AppLayout } = await import("./AppLayout");

function renderLayout() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/devices"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/devices" element={<div>DEVICES-PAGE</div>} />
            <Route path="/" element={<div>HOME-PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  authCtx.logout.mockClear();
  projectCtx.setProjectId.mockClear();
  localStorage.clear();
});

describe("AppLayout", () => {
  test("renders all navigation items and the active page", () => {
    renderLayout();
    expect(screen.getByText("DEVICES-PAGE")).not.toBeNull();
    for (const label of [/仪表盘|Dashboard|Панель/i, /设备|Devices|Устройства/i, /日志|Logs/i, /固件|Firmware/i, /OTA/i]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  test("project selector shows the current project", () => {
    renderLayout();
    expect(screen.getByText("Alpha")).not.toBeNull();
  });

  test("language menu switches the UI to English", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: /English|中文|Русский|Українська|Italiano/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "English" }));
    await waitFor(() =>
      expect(screen.getAllByText(/Devices/i).length).toBeGreaterThan(0),
    );
    // app bar title follows the locale
    expect(screen.getAllByText(/Devices/i).length).toBeGreaterThan(1);
  });

  test("logout calls the auth logout", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: /账户|Account|Аккаунт/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /退出登录|Log out|Выйти/i }));
    expect(authCtx.logout).toHaveBeenCalled();
  });
});
