/**
 * Live log terminal for one device (xterm.js).
 *
 * On mount the REST history (newest page, limit 100) is written into the
 * terminal oldest-first, then useLogStream() keeps appending live events.
 * The toolbar offers Clear, a follow (auto-scroll) toggle and the current
 * WebSocket status. The terminal is disposed on unmount.
 *
 * xterm.js is mocked in tests (happy-dom cannot lay out the terminal), so
 * every xterm API call goes through the Terminal instance only — the mock
 * records writeln/clear/dispose/scrollToBottom calls.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import "@xterm/xterm/css/xterm.css";
import { fetchDeviceLogs } from "../api/logs";
import { useLogStream, type LogStreamEvent, type LogStreamStatus } from "../api/logStream";
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";

const DARK_TERMINAL_THEME = { background: "#121212", foreground: "#e6e6e6" };
const LIGHT_TERMINAL_THEME = { background: "#ffffff", foreground: "#1a1a1a" };

/** Numeric level -> label + ANSI foreground (xterm parses CSI color codes). */
const LEVEL_STYLES: Record<number, { label: string; color: string }> = {
  0: { label: "TRACE", color: "\x1b[90m" }, // gray
  1: { label: "DEBUG", color: "\x1b[90m" }, // gray
  2: { label: "INFO", color: "" }, // default foreground
  3: { label: "WARN", color: "\x1b[93m" }, // yellow
  4: { label: "ERROR", color: "\x1b[91m" }, // red
  5: { label: "CRIT", color: "\x1b[91m" }, // red
};
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

const STATUS_LABELS: Record<LogStreamStatus, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  open: "Connected",
  error: "Reconnecting…",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `[${iso}]`;
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const hh = pad(d.getHours(), 2);
  const mm = pad(d.getMinutes(), 2);
  const ss = pad(d.getSeconds(), 2);
  const mmm = pad(d.getMilliseconds(), 3);
  return `[${hh}:${mm}:${ss}.${mmm}]`;
}

/** `[HH:MM:SS.mmm] LEVEL [tag] message` with ANSI colors for the level. */
function formatLogLine(
  event: LogStreamEvent,
  t: (key: DictKey, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [formatTimestamp(event.received_at)];
  const style = event.level !== null ? LEVEL_STYLES[event.level] : undefined;
  if (style) {
    parts.push(style.color ? `${style.color}${style.label}${RESET}` : style.label);
  }
  if (event.tag) parts.push(`[${event.tag}]`);
  if (event.decode_state !== "decodable" || event.message === null) {
    // undecodable packet or missing message: dim placeholder instead of a line
    parts.push(`${GRAY}${t("logs.undecodable")}${RESET}`);
  } else {
    parts.push(event.message);
  }
  return parts.join(" ");
}

export function LogTerminalView({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  // same dark-mode detection as AppLayout: explicit mode, else resolved system
  const { mode, systemMode } = useColorScheme();
  const isDark = mode === "dark" || (mode === undefined && systemMode === "dark");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  const status = useLogStream(deviceId, {
    onEvent: (event) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      terminal.writeln(formatLogLine(event, t));
      if (followRef.current) terminal.scrollToBottom();
    },
  });

  // create the terminal once per device; history then live stream
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      scrollback: 5000,
      fontSize: 13,
      theme: DARK_TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    // happy-dom/jsdom have no layout: fit() can throw there, always guard it
    const tryFit = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore: layout is not measurable in test environments
      }
    };
    tryFit();
    window.addEventListener("resize", tryFit);
    terminalRef.current = terminal;

    let disposed = false;
    void fetchDeviceLogs(deviceId, { limit: 100 })
      .then((res) => {
        if (disposed) return;
        // the REST endpoint returns newest-first; the terminal reads
        // top-to-bottom, so replay the history oldest-first
        for (const event of [...res.events].reverse()) {
          terminal.writeln(formatLogLine(event, t));
        }
        if (followRef.current) terminal.scrollToBottom();
      })
      .catch(() => {
        // history fetch failure is non-fatal: the live stream keeps running
      });

    return () => {
      disposed = true;
      window.removeEventListener("resize", tryFit);
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [deviceId]);

  // follow the MUI color scheme without recreating the terminal
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
  }, [isDark]);

  const handleFollowChange = (next: boolean) => {
    followRef.current = next;
    setFollow(next);
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Button size="small" onClick={() => terminalRef.current?.clear()}>
          Clear
        </Button>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={follow}
              onChange={(e) => handleFollowChange(e.target.checked)}
            />
          }
          label="Follow"
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography
          variant="caption"
          color={status === "error" ? "error.main" : "text.secondary"}
        >
          {STATUS_LABELS[status]}
        </Typography>
      </Stack>
      <Box
        ref={containerRef}
        data-testid="log-terminal"
        sx={{
          height: 480,
          bgcolor: isDark ? DARK_TERMINAL_THEME.background : LIGHT_TERMINAL_THEME.background,
          borderRadius: 1,
          overflow: "hidden",
          p: 1,
          "& .xterm": { height: "100%" },
        }}
      />
    </Stack>
  );
}
