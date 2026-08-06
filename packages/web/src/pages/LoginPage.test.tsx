/**
 * LoginPage tests: form rendering, submit success navigation, error
 * display, and the authed-redirect.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { I18nProvider } from "../i18n/I18nContext";

const authApi = {
  login: mock(async () => {}),
  register: mock(async () => {}),
  logout: mock(async () => {}),
  fetchMe: mock(async () => ({})),
};
mock.module("../api/auth", () => authApi);

const authCtx = {
  status: "anon" as "loading" | "authed" | "anon",
  user: null as { userId: string; username: string } | null,
  login: mock(async () => {}),
  register: mock(async () => {}),
  logout: mock(async () => {}),
};
mock.module("../auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authCtx,
}));

const { LoginPage } = await import("./LoginPage");

function renderLogin() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  authCtx.status = "anon";
  authCtx.user = null;
  authCtx.login.mockClear();
  localStorage.clear();
});

describe("LoginPage", () => {
  test("renders the login form", () => {
    renderLogin();
    expect(screen.getByLabelText(/Имя пользователя|用户名|Username/)).not.toBeNull();
    expect(screen.getByLabelText(/Пароль|密码|Password/)).not.toBeNull();
    expect(screen.getByRole("button", { name: /Войти|登录|Log in/i })).not.toBeNull();
  });

  test("submits credentials and navigates home on success", async () => {
    authCtx.login.mockImplementation(async () => {
      authCtx.status = "authed";
      authCtx.user = { userId: "u1", username: "tester" };
    });
    renderLogin();
    await userEvent.type(screen.getByLabelText(/用户名|Username/), "tester");
    await userEvent.type(screen.getByLabelText(/密码|Password/), "secret123");
    await userEvent.click(screen.getByRole("button", { name: /登录|Log in/i }));
    await waitFor(() => expect(screen.getByText("HOME")).not.toBeNull());
    expect(authCtx.login).toHaveBeenCalledWith("tester", "secret123");
  });

  test("shows the server error message on failure", async () => {
    authCtx.login.mockRejectedValue(
      new Error("invalid_credentials: invalid username or password"),
    );
    renderLogin();
    await userEvent.type(screen.getByLabelText(/用户名|Username/), "tester");
    await userEvent.type(screen.getByLabelText(/密码|Password/), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /登录|Log in/i }));
    await waitFor(() =>
      expect(screen.getByText(/invalid_credentials/)).not.toBeNull(),
    );
  });

  test("redirects to / when already authenticated", () => {
    authCtx.status = "authed";
    authCtx.user = { userId: "u1", username: "tester" };
    renderLogin();
    expect(screen.getByText("HOME")).not.toBeNull();
  });
});
