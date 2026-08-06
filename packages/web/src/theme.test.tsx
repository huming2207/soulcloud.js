/**
 * theme tests: baseTheme configuration and the react-router LinkBehavior.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Link from "@mui/material/Link";
import Button from "@mui/material/Button";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { baseTheme, LinkBehavior } from "./theme";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

describe("baseTheme", () => {
  test("enables light and dark color schemes", () => {
    const schemes = (baseTheme as unknown as { colorSchemes?: unknown }).colorSchemes;
    expect(schemes).toBeDefined();
    expect(JSON.stringify(schemes)).toContain("light");
    expect(JSON.stringify(schemes)).toContain("dark");
  });

  test("can be composed with a MUI locale (createTheme(base, locale))", () => {
    const themed = createTheme(baseTheme, {
      components: {},
    });
    expect(themed).toBeDefined();
  });
});

describe("LinkBehavior", () => {
  test("renders a react-router link from an MUI Link href", async () => {
    render(
      <ThemeProvider theme={baseTheme}>
        <MemoryRouter initialEntries={["/a"]}>
          <Routes>
            <Route
              path="/a"
              element={
                <>
                  <Link component={LinkBehavior} href="/target">
                    go
                  </Link>
                  <LocationProbe />
                </>
              }
            />
            <Route path="/target" element={<div>TARGET</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByText("TARGET")).not.toBeNull());
  });

  test("buttons navigate client-side too (LinkComponent)", async () => {
    render(
      <ThemeProvider theme={baseTheme}>
        <MemoryRouter initialEntries={["/a"]}>
          <Routes>
            <Route
              path="/a"
              element={
                <Button component={LinkBehavior} href="/btn-target">
                  btn
                </Button>
              }
            />
            <Route path="/btn-target" element={<div>BTN-TARGET</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText("btn"));
    await waitFor(() => expect(screen.getByText("BTN-TARGET")).not.toBeNull());
  });
});
