/**
 * NotFoundPage tests: the catch-all route renders a real 404 card with a
 * link back home (unknown paths previously rendered a blank page).
 */
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { I18nProvider } from "../i18n/I18nContext";
import { NotFoundPage } from "./NotFoundPage";

function renderAt(path: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("NotFoundPage", () => {
  test("renders the 404 card with a home link", () => {
    renderAt("/no-such-route");
    expect(screen.getByText("404")).not.toBeNull();
    expect(screen.getByText(/页面不存在|Page not found/i)).not.toBeNull();
    expect(screen.getByRole("link", { name: /返回首页|Back to home/i })).not.toBeNull();
  });

  test("the home link points at /", () => {
    renderAt("/whatever");
    expect(screen.getByRole("link").getAttribute("href")).toBe("/");
  });
});
