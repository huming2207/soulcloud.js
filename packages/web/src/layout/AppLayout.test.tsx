/**
 * AppLayout tests: navigation, language menu, project selector, logout.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";
import { baseTheme } from "../theme";
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
    <ThemeProvider theme={baseTheme}>
      <I18nProvider>
      <MemoryRouter initialEntries={["/devices"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/devices" element={<div>DEVICES-PAGE</div>} />
            <Route path="/" element={<div>HOME-PAGE</div>} />
          </Route>
          <Route path="/login" element={<div>LOGIN-PAGE</div>} />
        </Routes>
      </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
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

  test("logout calls the auth logout and navigates to /login", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: /账户|Account|Аккаунт/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /退出登录|Log out|Выйти/i }));
    expect(authCtx.logout).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("LOGIN-PAGE")).not.toBeNull());
  });

  test("dark mode toggle flips the theme and the button label", async () => {
    renderLayout();
    const toggle = screen.getByRole("button", {
      name: /切换到深色模式|Switch to dark mode|Тёмная тема|Темна тема|Tema scura/i,
    });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /切换到浅色模式|Switch to light mode|Светлая тема|Світла тема|Tema chiara/i,
        }),
      ).not.toBeNull(),
    );
  });
});

describe("AppLayout page titles and project switching", () => {
  test("detail routes get specific app bar titles", () => {
    function renderAt(path: string) {
      return render(
        <ThemeProvider theme={baseTheme}>
          <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/devices/:deviceId" element={<div>DETAIL</div>} />
                <Route path="/rollouts/:rolloutId" element={<div>RDETAIL</div>} />
                <Route path="/ota-jobs/:jobId" element={<div>JOB</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
          </I18nProvider>
        </ThemeProvider>,
      );
    }
    const first = renderAt("/devices/d1");
    expect(screen.getAllByText(/Device Detail|设备详情/i).length).toBeGreaterThan(0);
    first.unmount();
    renderAt("/rollouts/r1");
    expect(screen.getAllByText(/Rollout Detail|升级详情/i).length).toBeGreaterThan(0);
  });

  test("switching the project selector calls setProjectId", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("combobox", { name: /选择项目|Select project/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Beta/ }));
    expect(projectCtx.setProjectId).toHaveBeenCalledWith("p2");
  });
});
