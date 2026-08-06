import { useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { createDevice } from "../api/devices";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";
import { useI18n } from "../i18n/I18nContext";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface CreatedCredential {
  mqtt_username: string;
  mqtt_password: string;
  note: string;
}

/** Create-device dialog; on success shows the one-time MQTT credential. */
export function NewDeviceDialog({ open, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const { projectId } = useProject();
  const [assignedId, setAssignedId] = useState("");
  const [deviceUid, setDeviceUid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [credential, setCredential] = useState<CreatedCredential | null>(null);

  const reset = () => {
    setAssignedId("");
    setDeviceUid("");
    setError(null);
    setSubmitting(false);
    setCredential(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await createDevice({
        project_id: projectId,
        assigned_id: assignedId.trim(),
        device_uid: deviceUid.trim(),
      });
      setCredential({
        mqtt_username: res.mqtt_username,
        mqtt_password: res.mqtt_password,
        note: res.note,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard unavailable (http context); nothing to do
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {credential ? (
        <>
          <DialogTitle>{t("newdev.created")}</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t("newdev.warning")}
            </Alert>
            <Stack spacing={1}>
              <CredentialRow
                label={t("cred.username")}
                value={credential.mqtt_username}
                onCopy={copy}
              />
              <CredentialRow
                label={t("cred.password")}
                value={credential.mqtt_password}
                onCopy={copy}
                monospace
              />
              <Typography variant="caption" color="text.secondary">
                {credential.note}
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} variant="contained">
              {t("cred.saved")}
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <DialogTitle>{t("newdev.title")}</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              {t("newdev.body")}
            </DialogContentText>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                label={t("newdev.assigned")}
                value={assignedId}
                onChange={(e) => setAssignedId(e.target.value)}
                required
                fullWidth
                autoFocus
                helperText={t("newdev.assignedHint")}
              />
              <TextField
                label={t("newdev.uid")}
                value={deviceUid}
                onChange={(e) => setDeviceUid(e.target.value)}
                required
                fullWidth
                helperText={t("newdev.uidHint")}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>取消</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? t("newdev.creating") : t("newdev.create")}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

function CredentialRow({
  label,
  value,
  onCopy,
  monospace = false,
}: {
  label: string;
  value: string;
  onCopy: (text: string) => void;
  monospace?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography
          variant="body1"
          sx={{
            fontFamily: monospace ? "monospace" : undefined,
            wordBreak: "break-all",
            flexGrow: 1,
          }}
        >
          {value}
        </Typography>
        <IconButton size="small" onClick={() => onCopy(value)} aria-label={t("cred.copy", { label })}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}
