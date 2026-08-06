/**
 * QueryState tests: skeleton and error/retry rendering.
 */
import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";
import { ListSkeleton, CardSkeleton, QueryError } from "./QueryState";

describe("ListSkeleton", () => {
  test("renders the requested number of skeleton rows", () => {
    const { container } = render(<ListSkeleton rows={3} />);
    expect(container.querySelectorAll(".MuiSkeleton-root").length).toBe(3);
  });

  test("defaults to four rows", () => {
    const { container } = render(<ListSkeleton />);
    expect(container.querySelectorAll(".MuiSkeleton-root").length).toBe(4);
  });
});

describe("CardSkeleton", () => {
  test("renders skeleton blocks", () => {
    const { container } = render(<CardSkeleton />);
    expect(container.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThan(0);
  });
});

describe("QueryError", () => {
  test("shows the error message", () => {
    render(
      <I18nProvider>
        <QueryError error={new Error("boom")} />
      </I18nProvider>,
    );
    expect(screen.getByText("boom")).not.toBeNull();
  });

  test("extracts the message from an axios-style error", () => {
    render(
      <I18nProvider>
        <QueryError error={{ isAxiosError: true, response: { data: { message: "forbidden" } } }} />
      </I18nProvider>,
    );
    expect(screen.getByText("forbidden")).not.toBeNull();
  });

  test("calls onRetry when the retry button is clicked", async () => {
    const onRetry = mock(() => {});
    render(
      <I18nProvider>
        <QueryError error={new Error("boom")} onRetry={onRetry} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /重试|Retry|Повторити/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  test("renders without a retry button when onRetry is absent", () => {
    render(
      <I18nProvider>
        <QueryError error={new Error("boom")} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
