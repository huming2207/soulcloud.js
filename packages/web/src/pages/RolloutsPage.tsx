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
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";

const STATE_COLOR: Record<RolloutState, "primary" | "warning" | "error" | "success"> = {
  running: "primary",
  paused: "warning",
  aborted: "error",
  completed: "success",
};

const STATE_LABEL: Record<RolloutState, DictKey> = {
  running: "rollout.state.running",
  paused: "rollout.state.paused",
  aborted: "rollout.state.aborted",
  completed: "rollout.state.completed",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

export function RolloutsPage() {
  const { t } = useI18n();
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
        {t("rollouts.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t("rollouts.hint")}
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
              <TableCell>{t("rollouts.colId")}</TableCell>
              <TableCell>{t("rollouts.colStrategy")}</TableCell>
              <TableCell>{t("rollouts.colState")}</TableCell>
              <TableCell>{t("rollouts.colApproval")}</TableCell>
              <TableCell>{t("rollouts.colPool")}</TableCell>
              <TableCell sx={{ width: 220 }}>{t("rollouts.colProgress")}</TableCell>
              <TableCell>{t("rollouts.colCreated")}</TableCell>
              <TableCell align="right">{t("rollouts.colActions")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !rollouts.isLoading && (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ color: "text.secondary" }}>
                  {t("rollouts.noRollouts")}
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
                    {r.strategy === "auto" ? t("rollouts.auto") : t("rollouts.grouped")}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={t(STATE_LABEL[r.state] ?? "state.unknown")}
                      color={STATE_COLOR[r.state]}
                    />
                  </TableCell>
                  <TableCell>{r.manual_approval ? t("common.yes") : "—"}</TableCell>
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
                      {t("rollouts.details")}
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
