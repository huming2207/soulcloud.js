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
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";

const ROLLOUT_STATE_COLOR: Record<RolloutState, "primary" | "warning" | "error" | "success"> = {
  running: "primary",
  paused: "warning",
  aborted: "error",
  completed: "success",
};

const ROLLOUT_STATE_LABEL: Record<RolloutState, DictKey> = {
  running: "rollout.state.running",
  paused: "rollout.state.paused",
  aborted: "rollout.state.aborted",
  completed: "rollout.state.completed",
};

const TARGET_LABEL: Record<OtaTargetState, DictKey> = {
  pending: "target.pending",
  leased: "target.leased",
  delivered: "target.delivered",
  delivering: "target.delivering",
  downloaded: "target.downloaded",
  installed: "target.installed",
  expired: "target.expired",
  completed: "target.completed",
  failed: "target.failed",
};

function phaseStateIndex(phases: Array<{ state: string }>): number {
  return phases.filter((p) => p.state === "completed").length;
}

export function RolloutDetailPage() {
  const { t } = useI18n();
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
        <QueryError error={rollout.error ?? new Error(t("rollout.detail.notFound"))} onRetry={() => rollout.refetch()} />
      ) : (
        <>
          <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {t("job.title", { id: r.rollout_id.slice(0, 8) })}
            </Typography>
            <Chip
              label={t(ROLLOUT_STATE_LABEL[r.state])}
              color={ROLLOUT_STATE_COLOR[r.state]}
              variant="outlined"
            />
            <Chip label={r.strategy === "auto" ? t("rollouts.auto") : t("rollouts.grouped")} size="small" />
            {r.manual_approval && <Chip label={t("rollout.detail.manualApproval")} size="small" color="warning" />}
          </Stack>

          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
            <Button
              variant="outlined"
              disabled={r.state !== "running" || acting}
              onClick={() => act(() => pauseRollout(r.rollout_id))}
            >
              {t("rollout.detail.pause")}
            </Button>
            <Button
              variant="outlined"
              disabled={r.state !== "paused" || acting}
              onClick={() => act(() => resumeRollout(r.rollout_id))}
            >
              {t("rollout.detail.resume")}
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={(r.state !== "running" && r.state !== "paused") || acting}
              onClick={() => act(() => abortRollout(r.rollout_id))}
            >
              {t("rollout.detail.abort")}
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={(r.state !== "aborted" && r.state !== "completed") || acting}
              onClick={() => act(() => rollbackRollout(r.rollout_id))}
            >
              {t("rollout.detail.rollback")}
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
                        {p.ratio !== null ? t("rollout.detail.cover", { pct: (p.ratio * 100).toFixed(0) }) : t("rollout.detail.group", { n: p.group_id ?? "" })}
                        {" · "}
                        {t("rollout.detail.devices", { count: p.target_count })}
                      </Typography>
                      {p.summary && (
                        <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap" }} useFlexGap>
                          {Object.entries(p.summary).map(([state, count]) => (
                            <Chip
                              key={state}
                              size="small"
                              variant="outlined"
                              label={`${t(TARGET_LABEL[state as OtaTargetState])} ${count}`}
                            />
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  }
                >
                  {p.state === "active"
                    ? t("rollout.detail.active")
                    : p.state === "completed"
                      ? t("rollout.detail.done")
                      : p.state === "paused"
                        ? t("rollout.detail.paused")
                        : t("rollout.detail.pending")}
                </StepLabel>
              </Step>
            ))}
          </Stepper>

          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }} gutterBottom>
                {t("rollout.detail.params")}
              </Typography>
              <ParamGrid
                entries={[
                  ["release_id", r.release_id],
                  ["from_release_id", r.from_release_id ?? t("rollout.detail.none")],
                  ["strategy", r.strategy],
                  [t("rollout.detail.pool"), `${r.pool_size} ${t("rollout.detail.units")}`],
                  [t("rollout.detail.successRatio"), `${(r.success_ratio * 100).toFixed(0)}%`],
                  [t("rollout.detail.minSample"), String(r.min_sample)],
                  [t("rollout.detail.phaseTimeout"), `${r.phase_timeout_hours} ${t("rollout.detail.unitsHours")}`],
                  [t("rollout.detail.stuckHours"), `${r.stuck_hours} ${t("rollout.detail.unitsHours")}`],
                  [t("rollout.detail.created"), new Date(r.created_at).toLocaleString("zh-CN")],
                ]}
              />
              {r.rollback_job_id && (
                <Box sx={{ mt: 1 }}>
                  <MuiLink component={Link} to={`/ota-jobs/${r.rollback_job_id}`}>
                    {t("rollout.detail.viewRollback", { id: r.rollback_job_id.slice(0, 8) })}
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
