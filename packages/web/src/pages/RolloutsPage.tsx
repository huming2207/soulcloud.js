import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { fetchRollouts } from "../api/firmware";
import { useProject } from "../layout/ProjectContext";
import { ListSkeleton, QueryError } from "../components/QueryState";
import type { RolloutState } from "../api/types";

const STATE_COLOR: Record<RolloutState, "primary" | "warning" | "error" | "success"> = {
  running: "primary",
  paused: "warning",
  aborted: "error",
  completed: "success",
};

const STATE_LABEL: Record<RolloutState, string> = {
  running: "进行中",
  paused: "已暂停",
  aborted: "已中止",
  completed: "已完成",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

export function RolloutsPage() {
  const { projectId } = useProject();
  const navigate = useNavigate();

  const rollouts = useQuery({
    queryKey: ["rollouts", projectId],
    queryFn: () => fetchRollouts(projectId ?? ""),
    enabled: Boolean(projectId),
    refetchInterval: 10_000,
  });

  const rows = rollouts.data?.rollouts ?? [];

  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        OTA 升级
      </Typography>
      <Typography variant="body2" color="text.secondary">
        分批升级在固件发布页创建（列表每 10 秒自动刷新）
      </Typography>
      {rollouts.isLoading ? (
        <ListSkeleton />
      ) : rollouts.error ? (
        <QueryError error={rollouts.error} onRetry={() => rollouts.refetch()} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>策略</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>批准</TableCell>
              <TableCell>设备池</TableCell>
              <TableCell sx={{ width: 220 }}>进度</TableCell>
              <TableCell>创建时间</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !rollouts.isLoading && (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ color: "text.secondary" }}>
                  暂无升级
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const done =
                (r.progress.completed ?? 0) + (r.progress.failed ?? 0);
              const pct = r.pool_size > 0 ? Math.round((done / r.pool_size) * 100) : 0;
              return (
                <TableRow key={r.rollout_id} hover>
                  <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                    {r.rollout_id.slice(0, 8)}…
                  </TableCell>
                  <TableCell>
                    {r.strategy === "auto" ? "自动分批" : "自定义分组"}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={STATE_LABEL[r.state]}
                      color={STATE_COLOR[r.state]}
                    />
                  </TableCell>
                  <TableCell>{r.manual_approval ? "是" : "—"}</TableCell>
                  <TableCell>{r.pool_size}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Box sx={{ flexGrow: 1 }}>
                        <LinearProgress
                          variant="determinate"
                          value={pct}
                          color={r.state === "aborted" ? "error" : "primary"}
                        />
                      </Box>
                      <Typography variant="caption" sx={{ minWidth: 44 }}>
                        {done}/{r.pool_size}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{formatTime(r.created_at)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => navigate(`/rollouts/${r.rollout_id}`)}
                    >
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      )}
    </Stack>
  );
}
