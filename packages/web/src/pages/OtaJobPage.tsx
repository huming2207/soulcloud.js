import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";

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

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

/** OTA job detail: per-device target states, polled while active. */
export function OtaJobPage() {
  const { t } = useI18n();
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
          {t("job.title", { id: jobId.slice(0, 8) })}
        </Typography>
        {j && (
          <>
            {Object.entries(j.summary).map(([state, count]) => (
              <Chip
                key={state}
                size="small"
                variant="outlined"
                label={`${t(TARGET_LABEL[state as OtaTargetState])} ${count}`}
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
        <QueryError error={new Error(t("job.notFound"))} onRetry={() => job.refetch()} />
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {t("job.release", { id: "" })}<Box component="span" sx={{ fontFamily: "monospace", fontSize: 12 }}>{j.release_id}</Box>
            {" · "}{t("job.createdAt", { time: formatTime(j.created_at) })}
          </Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("job.colDevice")}</TableCell>
                  <TableCell>{t("job.colState")}</TableCell>
                  <TableCell>{t("job.colDelivered")}</TableCell>
                  <TableCell>{t("job.colConfirmed")}</TableCell>
                  <TableCell>{t("job.colResult")}</TableCell>
                  <TableCell>{t("job.colFirmware")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {j.targets.map((target) => (
                  <TableRow key={target.device_id} hover>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                      {target.device_uid}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={t(TARGET_LABEL[target.state])}
                        color={TARGET_COLOR[target.state]}
                      />
                    </TableCell>
                    <TableCell>{formatTime(target.delivered_at)}</TableCell>
                    <TableCell>{formatTime(target.confirmed_at)}</TableCell>
                    <TableCell>
                      {target.result_code !== null ? (
                        <Tooltip title={target.result_message ?? ""}>
                          <Box
                            component="span"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: 12,
                              color: target.result_code === 0 ? "success.main" : "error.main",
                            }}
                          >
                            {target.result_code === 0 ? t("job.success") : t("job.failed", { code: target.result_code })}
                            {target.result_message ? ` ${target.result_message}` : ""}
                          </Box>
                        </Tooltip>
                      ) : (
                        <Box sx={{ color: "text.disabled" }}>—</Box>
                      )}
                    </TableCell>
                    <TableCell>
                      {target.current_fw ? (
                        <Tooltip title={target.current_fw}>
                          <Box sx={{ fontFamily: "monospace", fontSize: 12 }}>
                            {target.current_fw.slice(0, 12)}…
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
                      {t("job.noTargets")}
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
