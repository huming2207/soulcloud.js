/**
 * DashboardPage tests: project summary cards and the roadmap note.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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

const projectCtx: {
  projects: Array<{ project_id: string; name: string; device_count: number }>;
  projectId: string;
  project: { project_id: string; name: string; device_count: number } | null;
  setProjectId: ReturnType<typeof mock>;
} = {
  projects: [],
  projectId: "p1",
  project: { project_id: "p1", name: "My Project", device_count: 7 },
  setProjectId: mock(() => {}),
};
mock.module("../layout/ProjectContext", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => children,
  useProject: () => projectCtx,
}));

const { DashboardPage } = await import("./DashboardPage");

function renderDash() {
  return render(
    <I18nProvider>
      <DashboardPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  projectCtx.project = { project_id: "p1", name: "My Project", device_count: 7 };
});

describe("DashboardPage", () => {
  test("shows the current project name and device count", () => {
    renderDash();
    expect(screen.getByText("My Project")).not.toBeNull();
    expect(screen.getByText("7")).not.toBeNull();
    expect(screen.getByText(/当前项目|Current project|Текущий проект/i)).not.toBeNull();
    expect(screen.getByText(/设备总数|Total devices|Всего устройств/i)).not.toBeNull();
  });

  test("welcomes the user by name", () => {
    renderDash();
    expect(screen.getByText(/tester/)).not.toBeNull();
  });

  test("renders a skeleton while the project is unknown", () => {
    projectCtx.project = null;
    const { container } = renderDash();
    expect(container.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
  });
});
