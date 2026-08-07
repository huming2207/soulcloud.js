/**
 * useCommandHistory tests: zsh-style navigation (up/down + draft
 * restore), dedupe/cap persistence, and per-device isolation. Driven
 * through a real component with fireEvent (the project's established
 * pattern - renderHook+act does not flush in this environment).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useCommandHistory } from "./useCommandHistory";

/** Mirrors how CommandForm wires the history hook. */
function Harness({ deviceId }: { deviceId: string }) {
  const history = useCommandHistory(deviceId);
  const [value, setValue] = useState("");
  return (
    <div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            const v = history.up(value);
            if (v !== null) {
              e.preventDefault();
              setValue(v);
            }
          } else if (e.key === "ArrowDown") {
            const v = history.down();
            if (v !== null) {
              e.preventDefault();
              setValue(v);
            }
          }
        }}
        data-testid="input"
      />
      <button onClick={() => history.commit(value)}>commit</button>
    </div>
  );
}

function renderHarness(deviceId = "d1") {
  render(<Harness deviceId={deviceId} />);
  return screen.getByTestId("input") as HTMLInputElement;
}

function press(input: HTMLInputElement, key: string) {
  fireEvent.keyDown(input, { key });
}

function commit(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText("commit"));
}

beforeEach(() => {
  localStorage.clear();
});

describe("useCommandHistory", () => {
  test("ArrowUp walks from the most recent entry to the oldest", async () => {
    const input = renderHarness();
    commit(input, "reboot");
    commit(input, "status");
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("status"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("reboot"));
    // already at the oldest: the input stays put
    press(input, "ArrowUp");
    await new Promise((r) => setTimeout(r, 10));
    expect(input.value).toBe("reboot");
  });

  test("ArrowDown walks back and restores the draft at the bottom", async () => {
    const input = renderHarness();
    commit(input, "reboot");
    commit(input, "status");
    fireEvent.change(input, { target: { value: "my-draft" } });
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("status"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("reboot"));
    press(input, "ArrowDown");
    await waitFor(() => expect(input.value).toBe("status"));
    press(input, "ArrowDown");
    await waitFor(() => expect(input.value).toBe("my-draft"));
    // idle: ArrowDown does nothing
    press(input, "ArrowDown");
    await new Promise((r) => setTimeout(r, 10));
    expect(input.value).toBe("my-draft");
  });

  test("commit dedupes consecutive repeats but keeps interleaved ones", async () => {
    const input = renderHarness();
    commit(input, "reboot");
    commit(input, "reboot");
    commit(input, "status");
    commit(input, "reboot");
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("reboot"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("status"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("reboot"));
  });

  test("empty commands are ignored", async () => {
    const input = renderHarness();
    commit(input, "   ");
    press(input, "ArrowUp");
    await new Promise((r) => setTimeout(r, 10));
    // nothing was recorded: ArrowUp leaves the draft untouched
    expect(input.value).toBe("   ");
  });

  test("history persists across remounts and is capped", async () => {
    const input = renderHarness();
    for (const c of ["a", "b", "c", "d"]) commit(input, c);
    // cap 3: oldest ("a") dropped
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("d"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("c"));
    press(input, "ArrowUp");
    await waitFor(() => expect(input.value).toBe("b"));
  });

  test("histories are isolated per device", async () => {
    const input = renderHarness("d1");
    commit(input, "reboot");
    cleanup(); // unmount d1's harness before mounting d2
    const other = renderHarness("d2");
    press(other, "ArrowUp");
    await new Promise((r) => setTimeout(r, 10));
    expect(other.value).toBe("");
  });

  test("corrupt storage falls back to an empty history", async () => {
    localStorage.setItem("soulcloud.cmdhistory.d9", "{not json");
    const input = renderHarness("d9");
    press(input, "ArrowUp");
    await new Promise((r) => setTimeout(r, 10));
    expect(input.value).toBe("");
  });
});
