import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
import Typography from "@mui/material/Typography";
import MuiLink from "@mui/material/Link";
import {
  abortRollout,
  fetchRollout,
  pauseRollout,
  resumeRollout,
  rollbackRollout,
} from "../api/firmware";
import { errorMessage } from "../api/http";
import { CardSkeleton, QueryError } from "../components/QueryState";
import type { OtaTargetState, RolloutState } from "../api/types";

const ROLLOUT_STATE_COLOR: Record<RolloutState, "primary" | "warning" | "error" | "success"> = {
  running: "primary",
  paused: "warning",
  aborted: "error",
  completed: "success",
};

const ROLLOUT_STATE_LABEL: Record<RolloutState, string> = {
  running: "进行中",
  paused: "已暂停",
  aborted: "已中止",
  completed: "已完成",
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

function phaseStateIndex(phases: Array<{ state: string }>): number {
  return phases.filter((p) => p.state === "completed").length;
}

export function RolloutDetailPage() {
  const { rolloutId } = useParams<{ rolloutId: string }>();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const rollout = useQuery({
    queryKey: ["rollout", rolloutId],
    queryFn: () => fetchRollout(rolloutId ?? ""),
    enabled: Boolean(rolloutId),
    refetchInterval: 5000,
  });

  if (!rolloutId) return null;
  const r = rollout.data;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setActing(true);
    try {
      await fn();
      queryClient.invalidateQueries({ queryKey: ["rollout", rolloutId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setActing(false);
    }
  };

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {rollout.isLoading ? (
        <CardSkeleton />
      ) : rollout.error || !r ? (
        <QueryError error={rollout.error ?? new Error("升级不存在")} onRetry={() => rollout.refetch()} />
      ) : (
        <>
          <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              升级 {r.rollout_id.slice(0, 8)}
            </Typography>
            <Chip
              label={ROLLOUT_STATE_LABEL[r.state]}
              color={ROLLOUT_STATE_COLOR[r.state]}
              variant="outlined"
            />
            <Chip label={r.strategy === "auto" ? "自动分批" : "自定义分组"} size="small" />
            {r.manual_approval && <Chip label="需手动批准" size="small" color="warning" />}
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
            <Button
              variant="outlined"
              disabled={r.state !== "running" || acting}
              onClick={() => act(() => pauseRollout(r.rollout_id))}
            >
              暂停
            </Button>
            <Button
              variant="outlined"
              disabled={r.state !== "paused" || acting}
              onClick={() => act(() => resumeRollout(r.rollout_id))}
            >
              恢复
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={(r.state !== "running" && r.state !== "paused") || acting}
              onClick={() => act(() => abortRollout(r.rollout_id))}
            >
              中止
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={(r.state !== "aborted" && r.state !== "completed") || acting}
              onClick={() => act(() => rollbackRollout(r.rollout_id))}
            >
              回滚
            </Button>
          </Stack>

          <Stepper
            activeStep={phaseStateIndex(r.phases)}
            alternativeLabel
            sx={{ py: 2, overflowX: "auto" }}
          >
            {r.phases.map((p) => (
              <Step key={p.index} completed={p.state === "completed"}>
                <StepLabel
                  optional={
                    <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
                      <Typography variant="caption" color="text.secondary">
                        {p.ratio !== null ? `覆盖 ${(p.ratio * 100).toFixed(0)}%` : `第 ${p.group_id} 组`}
                        {" · "}
                        {p.target_count} 台
                      </Typography>
                      {p.summary && (
                        <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap" }} useFlexGap>
                          {Object.entries(p.summary).map(([state, count]) => (
                            <Chip
                              key={state}
                              size="small"
                              variant="outlined"
                              label={`${TARGET_LABEL[state as OtaTargetState]} ${count}`}
                            />
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  }
                >
                  {p.state === "active"
                    ? "进行中"
                    : p.state === "completed"
                      ? "已完成"
                      : p.state === "paused"
                        ? "已暂停"
                        : "未开始"}
                </StepLabel>
              </Step>
            ))}
          </Stepper>

          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }} gutterBottom>
                参数
              </Typography>
              <ParamGrid
                entries={[
                  ["release_id", r.release_id],
                  ["from_release_id", r.from_release_id ?? "无"],
                  ["strategy", r.strategy],
                  ["设备池", `${r.pool_size} 台`],
                  ["成功率", `${(r.success_ratio * 100).toFixed(0)}%`],
                  ["最小样本", String(r.min_sample)],
                  ["阶段超时", `${r.phase_timeout_hours} 小时`],
                  ["卡住判定", `${r.stuck_hours} 小时`],
                  ["创建时间", new Date(r.created_at).toLocaleString("zh-CN")],
                ]}
              />
              {r.rollback_job_id && (
                <Box sx={{ mt: 1 }}>
                  <MuiLink component={Link} to={`/ota-jobs/${r.rollback_job_id}`}>
                    查看回滚任务 {r.rollback_job_id.slice(0, 8)}…
                  </MuiLink>
                </Box>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Stack>
  );
}

function ParamGrid({ entries }: { entries: Array<[string, string]> }) {
  return (
    <Stack direction="row" useFlexGap spacing={3} sx={{ flexWrap: "wrap" }}>
      {entries.map(([label, value]) => (
        <Box key={label}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {label}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              fontFamily: label === "release_id" || label === "from_release_id" ? "monospace" : undefined,
              fontSize: 12,
              wordBreak: "break-all",
            }}
          >
            {value}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}
