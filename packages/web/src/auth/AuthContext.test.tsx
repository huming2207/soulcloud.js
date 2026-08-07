/**
 * AuthContext tests: session restore, login, logout.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const authApi = {
  login: mock(async () => ({
    user_id: "u1",
    access_token: "acc-1",
    refresh_token: "ref-1",
  })),
  register: mock(async () => ({
    user_id: "u1",
    access_token: "acc-1",
    refresh_token: "ref-1",
  })),
  logout: mock(async () => {}),
  fetchMe: mock(async () => ({
    user_id: "u1",
    username: "tester",
    projects: [{ project_id: "p1", name: "proj", device_count: 0 }],
  })),
};

mock.module("../api/auth", () => authApi);

const { AuthProvider, useAuth } = await import("./AuthContext");

function Consumer() {
  const { status, user, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? "none"}</span>
      <button onClick={() => login("tester", "pw")}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithAuth(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  authApi.login.mockClear();
  authApi.logout.mockClear();
  authApi.fetchMe.mockClear();
  localStorage.clear();
  queryClient.clear();
});

describe("AuthContext", () => {
  test("starts anonymous without a stored refresh token", async () => {
    renderWithAuth(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));
    expect(authApi.fetchMe).not.toHaveBeenCalled();
  });

  test("restores the session from a stored refresh token", async () => {
    localStorage.setItem("soulcloud.refresh_token", "ref-1");
    renderWithAuth(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authed"));
    expect(screen.getByTestId("user").textContent).toBe("tester");
    expect(authApi.fetchMe).toHaveBeenCalled();
  });

  test("falls back to anonymous when restore fails", async () => {
    localStorage.setItem("soulcloud.refresh_token", "stale");
    authApi.fetchMe.mockRejectedValueOnce(new Error("expired"));
    queryClient.setQueryData(["devices"], [{ id: "leak" }]);
    renderWithAuth(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));
    expect(localStorage.getItem("soulcloud.refresh_token")).toBeNull();
    // the failed session must not leave cached data behind
    expect(queryClient.getQueryData(["devices"])).toBeUndefined();
  });

  test("login stores tokens and flips to authed", async () => {
    renderWithAuth(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));
    await userEvent.click(screen.getByText("login"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authed"));
    expect(screen.getByTestId("user").textContent).toBe("tester");
    expect(localStorage.getItem("soulcloud.refresh_token")).toBe("ref-1");
  });

  test("logout revokes server-side, clears caches and returns to anonymous", async () => {
    localStorage.setItem("soulcloud.refresh_token", "ref-1");
    queryClient.setQueryData(["devices"], [{ id: "a" }]);
    queryClient.setQueryData(["logs"], [{ id: "b" }]);
    renderWithAuth(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authed"));
    await userEvent.click(screen.getByText("logout"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anon"));
    expect(authApi.logout).toHaveBeenCalled();
    expect(localStorage.getItem("soulcloud.refresh_token")).toBeNull();
    // previous account's cached queries must not survive into the next login
    expect(queryClient.getQueryData(["devices"])).toBeUndefined();
    expect(queryClient.getQueryData(["logs"])).toBeUndefined();
  });
});
