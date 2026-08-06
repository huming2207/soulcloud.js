import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Link from "@mui/material/Link";
import CloseIcon from "@mui/icons-material/Close";
import {
  fetchCommandBatch,
  fetchDeviceCommands,
  postCommandBatch,
} from "../api/devices";
import { errorMessage } from "../api/http";
import type { CommandRecord, CommandState } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";

const STATE_COLOR: Record<CommandState, "default" | "info" | "primary" | "success" | "error"> = {
  queued: "default",
  leased: "info",
  broker_accepted: "primary",
  device_completed: "success",
  delivery_failed: "error",
};

const STATE_LABEL: Record<CommandState, DictKey> = {
  queued: "state.queued",
  leased: "state.leased",
  broker_accepted: "state.broker_accepted",
  device_completed: "state.device_completed",
  delivery_failed: "state.delivery_failed",
};

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Command issue form + history table + batch detail dialog for one device. */
export function CommandPanel({ deviceId }: { deviceId: string }) {
  const queryClient = useQueryClient();
  const refreshHistory = () =>
    queryClient.invalidateQueries({ queryKey: ["commands", deviceId] });
  return (
    <Stack spacing={3}>
      <CommandForm deviceId={deviceId} onEnqueued={refreshHistory} />
      <CommandHistory deviceId={deviceId} />
    </Stack>
  );
}

function CommandForm({ deviceId, onEnqueued }: { deviceId: string; onEnqueued: () => void }) {
  const { t } = useI18n();
  const [cmd, setCmd] = useState("");
  const [argsText, setArgsText] = useState("");
  const [timeoutText, setTimeoutText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    let args: unknown;
    if (argsText.trim() !== "") {
      try {
        args = JSON.parse(argsText);
        if (!Array.isArray(args)) throw new Error("args 必须是数组");
      } catch (err) {
        setError(`args 不是合法的 JSON 数组：${(err as Error).message}`);
        return;
      }
    }
    let deliveryTimeoutSeconds: number | undefined;
    if (timeoutText.trim() !== "") {
      const n = Number(timeoutText);
      if (!Number.isInteger(n) || n <= 0) {
        setError("投递超时必须是正整数（秒）");
        return;
      }
      deliveryTimeoutSeconds = n;
    }
    setSubmitting(true);
    try {
      const res = await postCommandBatch({
        device_ids: [deviceId],
        command: { cmd: cmd.trim(), args },
        ...(deliveryTimeoutSeconds !== undefined ? { delivery_timeout_seconds: deliveryTimeoutSeconds } : {}),
      });
      setSuccess(`已入队（批次 ${res.batch_id.slice(0, 8)}…，共 ${res.device_count} 台）`);
      setArgsText("");
      setTimeoutText("");
      onEnqueued();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" gutterBottom>
        {t("cmd.send")}
      </Typography>
      <form onSubmit={submit}>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {success && <Alert severity="success">{success}</Alert>}
          <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap" }} useFlexGap>
            <TextField
              label={t("cmd.name")}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              required
              sx={{ flex: "1 1 200px" }}
            />
            <TextField
              label={t("cmd.timeout")}
              value={timeoutText}
              onChange={(e) => setTimeoutText(e.target.value)}
              sx={{ flex: "1 1 160px" }}
              helperText={t("cmd.timeoutHint")}
            />
          </Stack>
          <TextField
            label={t("cmd.args")}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            multiline
            minRows={2}
            maxRows={6}
            fullWidth
            placeholder='[{"enabled": true}]'
            helperText={'每个元素为单键对象，如 [{"enabled": true}]'}
          />
          <Box>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? t("cmd.sending") : t("cmd.sendBtn")}
            </Button>
          </Box>
        </Stack>
      </form>
    </Paper>
  );
}

function CommandHistory({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  // refreshKey bumps after a new command is enqueued
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["commands", deviceId, cursor],
    queryFn: () => fetchDeviceCommands(deviceId, { limit: 50, cursor: cursor ?? undefined }),
    // command states move queued -> leased -> ... -> completed on the device
    refetchInterval: 10_000,
  });

  const rows = data?.commands ?? [];

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" gutterBottom>
        {t("cmd.history")}
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t("cmd.time")}</TableCell>
              <TableCell>seq</TableCell>
              <TableCell>{t("cmd.name")}</TableCell>
              <TableCell>{t("cmd.state")}</TableCell>
              <TableCell>{t("cmd.result")}</TableCell>
              <TableCell>{t("cmd.batch")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ color: "text.secondary" }}>
                  {t("cmd.noCommands")}
                </TableCell>
              </TableRow>
            )}
            {rows.map((c) => (
              <TableRow key={c.command_id} hover>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {formatTime(c.created_at)}
                </TableCell>
                <TableCell>{c.sequence}</TableCell>
                <TableCell>
                  <Box sx={{ fontFamily: "monospace" }}>{c.command?.cmd ?? t("cmd.undecodable")}</Box>
                  {c.command && formatArgs(c.command.args) !== "" && (
                    <Box sx={{ color: "text.secondary", fontSize: 12 }}>
                      {formatArgs(c.command.args)}
                    </Box>
                  )}
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={t(STATE_LABEL[c.state])}
                    color={STATE_COLOR[c.state]}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>
                  {c.result ? (
                    <Box
                      sx={{
                        color: c.result.code === 0 ? "success.main" : "error.main",
                        fontFamily: "monospace",
                      }}
                    >
                      code={c.result.code}
                      {c.result.payload
                        ? ` ${formatArgs(c.result.payload)}`
                        : ""}
                    </Box>
                  ) : (
                    <Box sx={{ color: "text.disabled" }}>—</Box>
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    component="button"
                    variant="body2"
                    onClick={() => setBatchId(c.batch_id)}
                    sx={{ fontFamily: "monospace", fontSize: 12 }}
                  >
                    {c.batch_id.slice(0, 8)}…
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mt: 1, display: "flex", justifyContent: "flex-end", gap: 1 }}>
        {isLoading && <Typography variant="caption">{t("cmd.loading")}</Typography>}
        {isFetching && !isLoading && (
          <Typography variant="caption">{t("cmd.refreshing")}</Typography>
        )}
        {data?.next_cursor && (
          <Button size="small" onClick={() => setCursor(data.next_cursor)}>
            {t("cmd.loadEarlier")}
          </Button>
        )}
        {cursor && (
          <Button size="small" onClick={() => setCursor(null)}>
            {t("cmd.backToLatest")}
          </Button>
        )}
      </Box>
      {batchId && (
        <BatchDialog batchId={batchId} onClose={() => setBatchId(null)} />
      )}
    </Paper>
  );
}

function BatchDialog({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ["batch", batchId],
    queryFn: () => fetchCommandBatch(batchId),
  });
  const rows = data?.commands ?? [];
  const summary = data?.summary ?? {};

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {t("cmd.batchTitle", { id: batchId })}
        <IconButton
          aria-label="关闭"
          onClick={onClose}
          sx={{ position: "absolute", right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap" }} useFlexGap>
          {Object.entries(summary).map(([state, count]) => (
            <Chip
              key={state}
              size="small"
              label={`${t(STATE_LABEL[state as CommandState])} ${count}`}
              color={STATE_COLOR[state as CommandState]}
              variant="outlined"
            />
          ))}
        </Stack>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("cmd.device")}</TableCell>
                <TableCell>{t("cmd.name")}</TableCell>
                <TableCell>{t("cmd.state")}</TableCell>
                <TableCell>{t("cmd.result")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.command_id} hover>
                  <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                    {c.device_uid}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {c.command?.cmd ?? t("cmd.undecodable")}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={t(STATE_LABEL[c.state])}
                      color={STATE_COLOR[c.state]}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                    {c.result ? `code=${c.result.code}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
    </Dialog>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}
