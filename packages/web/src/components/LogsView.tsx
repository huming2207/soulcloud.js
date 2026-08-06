import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { fetchDeviceLogs } from "../api/logs";
import { alpha } from "@mui/material/styles";
import { ListSkeleton } from "./QueryState";
import type { LogEvent } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

const LEVEL_COLOR = [
  "default", // 0
  "success", // 1
  "primary", // 2
  "warning", // 3
  "error", // 4
  "error", // 5 (critical)
] as const;

function formatDeviceTime(ms: string): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return ms;
  const seconds = Math.floor(n / 1000);
  const millis = n % 1000;
  return `${seconds}.${String(millis).padStart(3, "0")}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

/**
 * Decoded on9log event stream for one device. The newest page auto-refreshes
 * every 5s; browsing older pages (cursor set) disables the auto-refresh.
 */
export function LogsView({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [includeRaw, setIncludeRaw] = useState(false);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["logs", deviceId, cursor, includeRaw],
    queryFn: () =>
      fetchDeviceLogs(deviceId, {
        limit: 100,
        cursor: cursor ?? undefined,
        includeRaw,
      }),
    // only poll the newest page
    refetchInterval: cursor === null ? 5000 : false,
  });

  const events = data?.events ?? [];

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <FormControlLabel
          control={
            <Switch
              checked={includeRaw}
              onChange={(e) => {
                setIncludeRaw(e.target.checked);
                setCursor(null);
              }}
              size="small"
            />
          }
          label={t("logs.showRaw")}
        />
        <Box sx={{ flexGrow: 1 }} />
        {isFetching && (
          <Typography variant="caption" color="text.secondary">
            {t("logs.refreshing")}
          </Typography>
        )}
      </Stack>

      <Paper variant="outlined" sx={{ maxHeight: 560, overflow: "auto" }}>
        {isLoading && <ListSkeleton rows={6} />}
        {!isLoading && events.length === 0 && (
          <Typography sx={{ p: 2 }} variant="body2" color="text.secondary">
            {t("logs.noEvents")}
          </Typography>
        )}
        {events.map((e) => (
          <LogRow key={e.id} event={e} includeRaw={includeRaw} />
        ))}
      </Paper>

      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        {data?.next_cursor && (
          <Button size="small" onClick={() => setCursor(data.next_cursor)}>
            {t("logs.loadEarlier")}
          </Button>
        )}
        {cursor && (
          <Button size="small" onClick={() => setCursor(null)}>
            {t("logs.backToLatest")}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function LogRow({ event, includeRaw }: { event: LogEvent; includeRaw: boolean }) {
  const { t } = useI18n();
  const undecoded = event.decode_state !== "decodable";
  const level = event.level;

  return (
    <Box
      sx={{
        px: 2,
        py: 0.75,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-child": { borderBottom: 0 },
        display: "flex",
        gap: 1.5,
        alignItems: "flex-start",
        // soft tint that works in both light and dark schemes
        bgcolor:
          level !== null && level >= 4
            ? (t) => alpha(t.palette.error.main, t.palette.mode === "dark" ? 0.22 : 0.08)
            : undefined,
        opacity: undecoded ? 0.6 : 1,
      }}
    >
      <Box
        sx={{
          minWidth: 150,
          fontFamily: "monospace",
          fontSize: 12,
          color: "text.secondary",
          whiteSpace: "nowrap",
        }}
      >
        {formatTime(event.received_at)}
      </Box>
      <Box
        sx={{
          minWidth: 90,
          fontFamily: "monospace",
          fontSize: 12,
          color: "text.secondary",
          whiteSpace: "nowrap",
        }}
        title={`boot 相对时间 ${event.device_time_ms} ms`}
      >
        {formatDeviceTime(event.device_time_ms)}
      </Box>
      {level !== null && (
        <Chip
          size="small"
          variant="outlined"
          label={`L${level}`}
          color={LEVEL_COLOR[level] ?? "default"}
          sx={{ minWidth: 44, height: 20, fontSize: 11 }}
        />
      )}
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        {event.tag && (
          <Box
            component="span"
            sx={{ fontFamily: "monospace", fontSize: 12, color: "primary.main", mr: 1 }}
          >
            [{event.tag}]
          </Box>
        )}
        <Typography component="span" variant="body2" sx={{ wordBreak: "break-word" }}>
          {event.message ?? t("logs.undecodable")}
        </Typography>
        {includeRaw && event.raw_packet_b64 && (
          <Box
            component="pre"
            sx={{
              mt: 0.5,
              fontFamily: "monospace",
              fontSize: 11,
              color: "text.secondary",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {t("logs.raw", { packet: event.raw_packet_b64 })}
          </Box>
        )}
      </Box>
    </Box>
  );
}
