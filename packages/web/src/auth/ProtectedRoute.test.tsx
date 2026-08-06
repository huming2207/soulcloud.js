/**
 * ProtectedRoute tests: loading / anonymous / authenticated branches.
 */
import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const authCtx = {
  status: "loading" as "loading" | "authed" | "anon",
  user: null as { userId: string; username: string } | null,
  login: mock(async () => {}),
  register: mock(async () => {}),
  logout: mock(async () => {}),
};
mock.module("../auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => authCtx,
}));

const { ProtectedRoute } = await import("./ProtectedRoute");

function renderGuard(initial = "/protected") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div>PROTECTED-CONTENT</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>LOGIN-PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  test("shows a loader while the session is restoring", () => {
    authCtx.status = "loading";
    renderGuard();
    expect(screen.getByRole("progressbar")).not.toBeNull();
    expect(screen.queryByText("PROTECTED-CONTENT")).toBeNull();
  });

  test("redirects anonymous users to /login", () => {
    authCtx.status = "anon";
    renderGuard();
    expect(screen.getByText("LOGIN-PAGE")).not.toBeNull();
  });

  test("renders children for authenticated users", () => {
    authCtx.status = "authed";
    authCtx.user = { userId: "u1", username: "tester" };
    renderGuard();
    expect(screen.getByText("PROTECTED-CONTENT")).not.toBeNull();
    expect(screen.queryByText("LOGIN-PAGE")).toBeNull();
  });
});
