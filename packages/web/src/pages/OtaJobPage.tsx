import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { fetchOtaJob } from "../api/firmware";
import { CardSkeleton, QueryError } from "../components/QueryState";
import type { OtaTargetState } from "../api/types";

const TARGET_COLOR: Record<
  OtaTargetState,
  "default" | "info" | "primary" | "secondary" | "warning" | "error" | "success"
> = {
  pending: "default",
  leased: "info",
  delivered: "primary",
  delivering: "secondary",
  downloaded: "secondary",
  installed: "warning",
  expired: "error",
  completed: "success",
  failed: "error",
};

const TARGET_LABEL: Record<OtaTargetState, string> = {
  pending: "待投递",
  leased: "已领取",
  delivered: "已通知",
  delivering: "下载中",
  downloaded: "已下载",
  installed: "已安装",
  expired: "已过期",
  completed: "已完成",
  failed: "失败",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

/** OTA job detail: per-device target states, polled while active. */
export function OtaJobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const job = useQuery({
    queryKey: ["ota-job", jobId],
    queryFn: () => fetchOtaJob(jobId ?? ""),
    enabled: Boolean(jobId),
    refetchInterval: 5000,
  });

  if (!jobId) return null;
  const j = job.data;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          OTA 任务 {jobId.slice(0, 8)}
        </Typography>
        {j && (
          <>
            {Object.entries(j.summary).map(([state, count]) => (
              <Chip
                key={state}
                size="small"
                variant="outlined"
                label={`${TARGET_LABEL[state as OtaTargetState]} ${count}`}
                color={TARGET_COLOR[state as OtaTargetState]}
              />
            ))}
          </>
        )}
      </Stack>

      {job.isLoading ? (
        <CardSkeleton />
      ) : job.error ? (
        <QueryError error={job.error} onRetry={() => job.refetch()} />
      ) : !j ? (
        <QueryError error={new Error("任务不存在")} onRetry={() => job.refetch()} />
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            release：<Box component="span" sx={{ fontFamily: "monospace", fontSize: 12 }}>{j.release_id}</Box>
            {" · "}创建于 {formatTime(j.created_at)}（每 5 秒自动刷新）
          </Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>设备</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell>已通知</TableCell>
                  <TableCell>确认时间</TableCell>
                  <TableCell>结果</TableCell>
                  <TableCell>当前固件</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {j.targets.map((t) => (
                  <TableRow key={t.device_id} hover>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                      {t.device_uid}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={TARGET_LABEL[t.state]}
                        color={TARGET_COLOR[t.state]}
                      />
                    </TableCell>
                    <TableCell>{formatTime(t.delivered_at)}</TableCell>
                    <TableCell>{formatTime(t.confirmed_at)}</TableCell>
                    <TableCell>
                      {t.result_code !== null ? (
                        <Tooltip title={t.result_message ?? ""}>
                          <Box
                            component="span"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: 12,
                              color: t.result_code === 0 ? "success.main" : "error.main",
                            }}
                          >
                            {t.result_code === 0 ? "成功" : `失败 (${t.result_code})`}
                            {t.result_message ? ` ${t.result_message}` : ""}
                          </Box>
                        </Tooltip>
                      ) : (
                        <Box sx={{ color: "text.disabled" }}>—</Box>
                      )}
                    </TableCell>
                    <TableCell>
                      {t.current_fw ? (
                        <Tooltip title={t.current_fw}>
                          <Box sx={{ fontFamily: "monospace", fontSize: 12 }}>
                            {t.current_fw.slice(0, 12)}…
                          </Box>
                        </Tooltip>
                      ) : (
                        <Box sx={{ color: "text.disabled" }}>—</Box>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {j.targets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ color: "text.secondary" }}>
                      无目标设备
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Stack>
  );
}
