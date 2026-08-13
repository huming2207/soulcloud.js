/**
 * Time-ranged log export dialog: picks a [from, to] window and downloads
 * the streamed CSV export (GET /v1/devices/:id/logs/export). The backend
 * streams chunked rows, so the browser receives data as it is produced.
 */

import { useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { getAccessToken } from "../api/http";
import { useI18n } from "../i18n/I18nContext";

/** Date -> yyyy-MM-ddTHH:mm for datetime-local inputs. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface LogExportDialogProps {
  deviceId: string;
  /** Used for the downloaded file name. */
  deviceUid: string;
  open: boolean;
  onClose: () => void;
}

export function LogExportDialog({
  deviceId,
  deviceUid,
  open,
  onClose,
}: LogExportDialogProps) {
  const { t } = useI18n();
  const [from, setFrom] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 3600 * 1000)),
  );
  const [to, setTo] = useState(() => toLocalInput(new Date()));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();
      if (Number.isNaN(new Date(fromIso).getTime()) || Number.isNaN(new Date(toIso).getTime())) {
        setFailed(true);
        return;
      }
      const token = getAccessToken();
      const res = await fetch(
        `/v1/devices/${deviceId}/logs/export?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${deviceUid}-logs.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("logs.exportTitle")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label={t("logs.exportFrom")}
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          <TextField
            label={t("logs.exportTo")}
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          {failed && (
            <Typography variant="body2" color="error">
              {t("logs.exportError")}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={download} disabled={busy} variant="contained">
          {t("logs.exportDownload")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
