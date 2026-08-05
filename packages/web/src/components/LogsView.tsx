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
import type { LogEvent } from "../api/types";

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
      <Stack direction="row" alignItems="center" spacing={2}>
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
          label="显示原始包"
        />
        <Box sx={{ flexGrow: 1 }} />
        {isFetching && (
          <Typography variant="caption" color="text.secondary">
            刷新中…
          </Typography>
        )}
      </Stack>

      <Paper variant="outlined" sx={{ maxHeight: 560, overflow: "auto" }}>
        {isLoading && (
          <Typography sx={{ p: 2 }} variant="body2" color="text.secondary">
            加载日志…
          </Typography>
        )}
        {!isLoading && events.length === 0 && (
          <Typography sx={{ p: 2 }} variant="body2" color="text.secondary">
            暂无日志事件
          </Typography>
        )}
        {events.map((e) => (
          <LogRow key={e.id} event={e} includeRaw={includeRaw} />
        ))}
      </Paper>

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {data?.next_cursor && (
          <Button size="small" onClick={() => setCursor(data.next_cursor)}>
            加载更早
          </Button>
        )}
        {cursor && (
          <Button size="small" onClick={() => setCursor(null)}>
            回到最新
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function LogRow({ event, includeRaw }: { event: LogEvent; includeRaw: boolean }) {
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
        bgcolor: level !== null && level >= 4 ? "error.light" : undefined,
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
          {event.message ?? "（无法解码，原始包已保留）"}
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
            raw: {event.raw_packet_b64}
          </Box>
        )}
      </Box>
    </Box>
  );
}
