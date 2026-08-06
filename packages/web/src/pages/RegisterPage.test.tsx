/**
 * RegisterPage tests: client-side validation and submit flow.
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

const { RegisterPage } = await import("./RegisterPage");

function renderRegister() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/register"]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function fields() {
  return {
    username: screen.getByLabelText(/用户名|Username|Имя пользователя/),
    email: screen.getByLabelText(/邮箱|Email/),
    password: screen.getByLabelText(/^密码|^Password/),
    confirm: screen.getByLabelText(/确认密码|Confirm password/),
    submit: screen.getByRole("button", { name: /注册|Sign up|Регистрация/i }),
  };
}

beforeEach(() => {
  authCtx.status = "anon";
  authCtx.register.mockClear();
  localStorage.clear();
});

describe("RegisterPage", () => {
  test("rejects usernames with illegal characters", async () => {
    renderRegister();
    const f = fields();
    await userEvent.type(f.username, "bad name!");
    await userEvent.type(f.email, "a@b.com");
    await userEvent.type(f.password, "password123");
    await userEvent.type(f.confirm, "password123");
    await userEvent.click(f.submit);
    await waitFor(() =>
      expect(screen.getByText(/只能包含字母|may only contain|может содержать/i)).not.toBeNull(),
    );
    expect(authCtx.register).not.toHaveBeenCalled();
  });

  test("rejects short passwords", async () => {
    renderRegister();
    const f = fields();
    await userEvent.type(f.username, "goodname");
    await userEvent.type(f.email, "a@b.com");
    await userEvent.type(f.password, "short");
    await userEvent.type(f.confirm, "short");
    await userEvent.click(f.submit);
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(
        /至少 8|at least 8|не менее 8|8 символов|8 caratteri/i,
      );
    });
    expect(authCtx.register).not.toHaveBeenCalled();
  });

  test("rejects mismatched password confirmation", async () => {
    renderRegister();
    const f = fields();
    await userEvent.type(f.username, "goodname");
    await userEvent.type(f.email, "a@b.com");
    await userEvent.type(f.password, "password123");
    await userEvent.type(f.confirm, "password124");
    await userEvent.click(f.submit);
    await waitFor(() =>
      expect(screen.getByText(/不一致|do not match|не совпадают|не збігаються/i)).not.toBeNull(),
    );
    expect(authCtx.register).not.toHaveBeenCalled();
  });

  test("registers and navigates home on success", async () => {
    authCtx.register.mockImplementation(async () => {
      authCtx.status = "authed";
      authCtx.user = { userId: "u1", username: "goodname" };
    });
    renderRegister();
    const f = fields();
    await userEvent.type(f.username, "goodname");
    await userEvent.type(f.email, "a@b.com");
    await userEvent.type(f.password, "password123");
    await userEvent.type(f.confirm, "password123");
    await userEvent.click(f.submit);
    await waitFor(() => expect(screen.getByText("HOME")).not.toBeNull());
    expect(authCtx.register).toHaveBeenCalledWith(
      "goodname",
      "password123",
      "a@b.com",
    );
  });

  test("shows the server error (e.g. username taken)", async () => {
    authCtx.register.mockRejectedValue(
      new Error("username_or_email_taken: already registered"),
    );
    renderRegister();
    const f = fields();
    await userEvent.type(f.username, "taken");
    await userEvent.type(f.email, "a@b.com");
    await userEvent.type(f.password, "password123");
    await userEvent.type(f.confirm, "password123");
    await userEvent.click(f.submit);
    await waitFor(() =>
      expect(screen.getByText(/username_or_email_taken/)).not.toBeNull(),
    );
  });
});
