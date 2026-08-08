/**
 * LogTerminalView tests. xterm.js is mocked at the module level (happy-dom
 * cannot lay out a real terminal): the mock Terminal records writeln lines
 * and clear/dispose/scrollToBottom/fit call counts and accepts options.
 * useLogStream is mocked too so tests can fire live events deterministically.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";
import type { LogListResponse, LogEvent } from "../api/types";
import type { LogStreamEvent } from "../api/logStream";

// --- xterm mocks -------------------------------------------------------------

class TerminalMock {
  options: Record<string, unknown>;
  writelnCalls: string[] = [];
  clearCalls = 0;
  disposeCalls = 0;
  fitCalls = 0;
  scrollToBottomCalls = 0;
  openCalls = 0;
  constructor(options?: Record<string, unknown>) {
    this.options = options ?? {};
    terminalInstances.push(this);
  }
  writeln(line: string) {
    this.writelnCalls.push(line);
  }
  clear() {
    this.clearCalls++;
  }
  dispose() {
    this.disposeCalls++;
  }
  scrollToBottom() {
    this.scrollToBottomCalls++;
  }
  open() {
    this.openCalls++;
  }
  loadAddon(addon: unknown) {
    // link the fit addon back to this terminal so fit() can be counted here
    (addon as { terminal?: TerminalMock }).terminal = this;
  }
}

let throwOnFit = false;
class FitAddonMock {
  fitCalls = 0;
  fit() {
    if (throwOnFit) throw new Error("fit: container has no layout");
    this.fitCalls++;
    const linked = (this as unknown as { terminal?: TerminalMock }).terminal;
    if (linked) linked.fitCalls++;
  }
}

const terminalInstances: TerminalMock[] = [];
mock.module("@xterm/xterm", () => ({ Terminal: TerminalMock }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: FitAddonMock }));

// --- api mocks ---------------------------------------------------------------

type OnEvent = (event: LogStreamEvent) => void;

let capturedOnEvent: OnEvent | null = null;
let streamStatus: "idle" | "connecting" | "open" | "error" = "open";
const logStreamApi = {
  useLogStream: mock(
    (
      _deviceId: string,
      opts: { onEvent?: OnEvent; enabled?: boolean; retryBaseMs?: number },
    ) => {
      capturedOnEvent = opts.onEvent ?? null;
      return streamStatus;
    },
  ),
};
mock.module("../api/logStream", () => logStreamApi);

const logsApi = {
  fetchDeviceLogs: mock(
    async (
      _deviceId: string,
      _params: { limit?: number; cursor?: string; includeRaw?: boolean },
    ): Promise<LogListResponse> => ({ events: [], next_cursor: null }),
  ),
};
mock.module("../api/logs", () => logsApi);

const { LogTerminalView } = await import("./LogTerminalView");

// mirrors the REAL REST contract: the endpoint returns newest-first
// (orderBy id desc); the view must reverse before replaying
const historyEvents: LogEvent[] = [
  {
    id: "h2",
    received_at: "2026-08-06T10:00:01.000Z",
    device_time_ms: "2000",
    sequence: 2,
    packet_type: 1,
    level: 4,
    tag: null,
    message: "history line two",
    decode_state: "decodable",
  },
  {
    id: "h1",
    received_at: "2026-08-06T10:00:00.000Z",
    device_time_ms: "1000",
    sequence: 1,
    packet_type: 1,
    level: 2,
    tag: "demo",
    message: "history line one",
    decode_state: "decodable",
  },
];

function liveEvent(overrides: Partial<LogStreamEvent> = {}): LogStreamEvent {
  return {
    id: "live1",
    received_at: "2026-08-06T10:00:02.000Z",
    device_time_ms: "3000",
    sequence: 3,
    packet_type: 1,
    level: 3,
    tag: "app",
    message: "live line",
    decode_state: "decodable",
    ...overrides,
  };
}

function renderTerminal() {
  return render(
    <I18nProvider>
      <LogTerminalView deviceId="d1" />
    </I18nProvider>,
  );
}

function lastLine(): string {
  const terminal = terminalInstances.at(-1);
  expect(terminal).toBeDefined();
  return terminal!.writelnCalls.at(-1) ?? "";
}

beforeEach(() => {
  terminalInstances.length = 0;
  capturedOnEvent = null;
  streamStatus = "open";
  throwOnFit = false;
  logsApi.fetchDeviceLogs.mockClear();
  logsApi.fetchDeviceLogs.mockResolvedValue({
    events: historyEvents,
    next_cursor: null,
  });
  logStreamApi.useLogStream.mockClear();
});

describe("LogTerminalView", () => {
  test("sanitizeTerminalText strips C0/C1 control characters but keeps \\n and \\t", () => {
    const { sanitizeTerminalText } = require("./LogTerminalView") as typeof import("./LogTerminalView");
    expect(sanitizeTerminalText("plain text")).toBe("plain text");
    // CSI color sequences lose the ESC byte; the leftover "[31m" is
    // inert printable text that xterm will not interpret
    expect(sanitizeTerminalText("boot\u001b[31mred\u001b[0m")).toBe("boot[31mred[0m");
    // OSC-8 hyperlink payloads lose both ESC and BEL (\x07)
    expect(sanitizeTerminalText("a\u001b]8;;http://x\u0007b")).toBe("a]8;;http://xb");
    // C1 range 0x7F-0x9F (e.g. 0x9B CSI single-byte) is dropped
    expect(sanitizeTerminalText("x\u009by")).toBe("xy");
    // DEL 0x7F dropped; line structure kept
    expect(sanitizeTerminalText("line1\n\tline2\u007f")).toBe("line1\n\tline2");
  });

  test("device-controlled escape sequences never reach the terminal", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    await waitFor(() => expect(terminal.writelnCalls.length).toBe(2));

    expect(capturedOnEvent).not.toBeNull();
    // a hostile message with a CSI erase-line + fake WARN line
    const evil = liveEvent({
      message: "\u001b[2K\u001b[31mFAKE ERROR\u001b[0m",
      tag: "\u001b]8;;https://evil.example\u0007demo\u001b]8;;\u0007",
    });
    await act(async () => {
      capturedOnEvent!(evil);
    });
    const line = lastLine();
    // level coloring is the ONLY ANSI in the line; no CSI/OSC from the
    // device survives (the leftover text is inert and safe to display)
    expect(line).not.toContain("\u001b[2K");
    expect(line).not.toContain("\u001b]8;");
    expect(line).not.toContain("\u001b[31m");
    expect(line).toContain("WARN"); // real level label survives
    expect(line).toContain("demo"); // sanitized tag keeps its text
  });

  test("mounts an xterm terminal, fits it and writes REST history oldest-first", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;

    // constructor options: convertEol, scrollback, fontSize, theme
    expect(terminal.options.convertEol).toBe(true);
    expect(terminal.options.scrollback).toBe(5000);
    expect(terminal.options.fontSize).toBe(13);

    await waitFor(() => expect(terminal.writelnCalls.length).toBe(2));
    expect(terminal.writelnCalls[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO \[demo\] history line one$/);
    expect(terminal.writelnCalls[1]).toContain("ERROR");
    expect(terminal.writelnCalls[1]).toContain("history line two");
    // history write scrolls to bottom while follow is on
    expect(terminal.scrollToBottomCalls).toBeGreaterThan(0);
    // fit was attempted on mount
    expect(terminal.fitCalls).toBeGreaterThan(0);
  });

  test("live events from useLogStream are written with time and level", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    await waitFor(() => expect(terminal.writelnCalls.length).toBe(2));

    expect(capturedOnEvent).not.toBeNull();
    const scrollsBefore = terminal.scrollToBottomCalls;
    await act(async () => {
      capturedOnEvent!(liveEvent());
    });
    const ESC = "\u001b";
    const line = lastLine();
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    // WARN is wrapped in ANSI yellow (CSI 93m ... reset)
    expect(line).toContain(`${ESC}[93mWARN${ESC}[0m [app] live line`);
    // follow is on by default: the new line forces a scroll to bottom
    expect(terminal.scrollToBottomCalls).toBe(scrollsBefore + 1);
  });

  test("undecodable events (null message / unknown_fw) get a placeholder line", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    await waitFor(() => expect(capturedOnEvent).not.toBeNull());

    await act(async () => {
      capturedOnEvent!(
        liveEvent({ id: "u1", message: null, decode_state: "unknown_fw" }),
      );
    });
    expect(lastLine()).toContain("(undecodable, raw retained)");

    await act(async () => {
      capturedOnEvent!(
        liveEvent({ id: "u2", message: "not decoded", decode_state: "unknown_fw" }),
      );
    });
    // decode_state unknown_fw also forces the placeholder even with a message
    expect(lastLine()).toContain("(undecodable, raw retained)");
    expect(lastLine()).not.toContain("not decoded");
  });

  test("Clear button empties the terminal", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(terminal.clearCalls).toBe(1);
  });

  test("disabling follow stops new lines from scrolling to bottom", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    await waitFor(() => expect(capturedOnEvent).not.toBeNull());

    await userEvent.click(screen.getByRole("switch")); // follow off
    expect(screen.getByRole("switch")).toHaveProperty("checked", false);

    const scrollsBefore = terminal.scrollToBottomCalls;
    await act(async () => {
      capturedOnEvent!(liveEvent({ id: "noscroll" }));
    });
    expect(lastLine()).toContain("live line");
    expect(terminal.scrollToBottomCalls).toBe(scrollsBefore);
  });

  test("shows the stream status from useLogStream", async () => {
    streamStatus = "connecting";
    renderTerminal();
    await waitFor(() => expect(screen.getByText("Connecting…")).not.toBeNull());
  });

  test("window resize triggers another fit", async () => {
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    const fitsBefore = terminal.fitCalls;
    // happy-dom only accepts events created from its own Window constructor
    window.dispatchEvent(new window.Event("resize"));
    expect(terminal.fitCalls).toBe(fitsBefore + 1);
  });

  test("fit throwing (no layout in happy-dom) does not break the mount", async () => {
    throwOnFit = true;
    renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    // history lines are still written despite the failed fit
    await waitFor(() => expect(terminalInstances[0]!.writelnCalls.length).toBe(2));
    // a resize-triggered fit is guarded too
    expect(() => window.dispatchEvent(new window.Event("resize"))).not.toThrow();
    expect(terminalInstances[0]!.writelnCalls.length).toBe(2);
  });

  test("unmount disposes the terminal", async () => {
    const { unmount } = renderTerminal();
    await waitFor(() => expect(terminalInstances.length).toBe(1));
    const terminal = terminalInstances[0]!;
    unmount();
    expect(terminal.disposeCalls).toBe(1);
  });
});
