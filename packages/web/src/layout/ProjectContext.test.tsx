/**
 * ProjectContext tests: selection persistence and auto-correction.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const authApi = {
  login: mock(async () => ({})),
  register: mock(async () => ({})),
  logout: mock(async () => {}),
  fetchMe: mock(async () => ({
    user_id: "u1",
    username: "tester",
    projects: [
      { project_id: "p1", name: "Alpha", device_count: 2 },
      { project_id: "p2", name: "Beta", device_count: 5 },
    ],
  })),
};

mock.module("../api/auth", () => authApi);

const { AuthProvider } = await import("../auth/AuthContext");
const { ProjectProvider, useProject } = await import("./ProjectContext");

function Consumer() {
  const { projects, projectId, project, setProjectId } = useProject();
  return (
    <div>
      <span data-testid="projectId">{projectId ?? "none"}</span>
      <span data-testid="projectName">{project?.name ?? "none"}</span>
      <span data-testid="count">{projects.length}</span>
      <button onClick={() => setProjectId("p2")}>pick-p2</button>
    </div>
  );
}

function renderProject() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // authed session so useMeQuery is enabled
  localStorage.setItem("soulcloud.refresh_token", "ref-1");
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ProjectProvider>
          <Consumer />
        </ProjectProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authApi.fetchMe.mockClear();
  localStorage.clear();
});

describe("ProjectContext", () => {
  test("loads projects and falls back to the first project", async () => {
    renderProject();
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    await waitFor(() => expect(screen.getByTestId("projectId").textContent).toBe("p1"));
    expect(screen.getByTestId("projectName").textContent).toBe("Alpha");
    // the fallback is persisted
    expect(localStorage.getItem("soulcloud.project_id")).toBe("p1");
  });

  test("keeps a stored selection that still exists", async () => {
    localStorage.setItem("soulcloud.project_id", "p2");
    renderProject();
    await waitFor(() =>
      expect(screen.getByTestId("projectName").textContent).toBe("Beta"),
    );
    expect(screen.getByTestId("projectId").textContent).toBe("p2");
  });

  test("corrects a stored selection that no longer exists", async () => {
    localStorage.setItem("soulcloud.project_id", "gone");
    renderProject();
    await waitFor(() =>
      expect(screen.getByTestId("projectName").textContent).toBe("Alpha"),
    );
    expect(screen.getByTestId("projectId").textContent).toBe("p1");
    expect(localStorage.getItem("soulcloud.project_id")).toBe("p1");
  });

  test("setProjectId persists the new selection", async () => {
    renderProject();
    await waitFor(() => expect(screen.getByTestId("projectId").textContent).toBe("p1"));
    await userEvent.click(screen.getByText("pick-p2"));
    await waitFor(() =>
      expect(screen.getByTestId("projectName").textContent).toBe("Beta"),
    );
    expect(screen.getByTestId("projectId").textContent).toBe("p2");
    expect(localStorage.getItem("soulcloud.project_id")).toBe("p2");
  });
});
