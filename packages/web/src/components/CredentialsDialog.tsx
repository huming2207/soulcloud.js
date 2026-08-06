import { useState } from "react";
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
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { issueCredentials } from "../api/devices";
import { errorMessage } from "../api/http";

interface Props {
  deviceId: string;
  open: boolean;
  onClose: () => void;
  onIssued: () => void;
}

interface Issued {
  mqtt_username: string;
  mqtt_password: string;
}

/**
 * Two-step credential dialog: confirm first (old credentials die
 * immediately, live session kicked), then show the one-time password.
 */
export function CredentialsDialog({ deviceId, open, onClose, onIssued }: Props) {
  const [confirming, setConfirming] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);

  const reset = () => {
    setConfirming(true);
    setSubmitting(false);
    setError(null);
    setIssued(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const issue = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await issueCredentials(deviceId);
      setIssued({ mqtt_username: res.mqtt_username, mqtt_password: res.mqtt_password });
      setConfirming(false);
      onIssued();
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
      // clipboard unavailable; nothing to do
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {confirming ? (
        <>
          <DialogTitle>发放新的 MQTT 凭据</DialogTitle>
          <DialogContent>
            <DialogContentText>
              新密码会立即替换旧密码，正在使用旧凭据的设备连接会被踢下线。
              此操作无法撤销。
            </DialogContentText>
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>取消</Button>
            <Button onClick={issue} variant="contained" disabled={submitting}>
              {submitting ? "发放中…" : "确认发放"}
            </Button>
          </DialogActions>
        </>
      ) : issued ? (
        <>
          <DialogTitle>新凭据已发放</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              密码仅显示这一次，请立即保存并配置到设备。
            </Alert>
            <Stack spacing={1}>
              <Row label="MQTT 用户名" value={issued.mqtt_username} onCopy={copy} />
              <Row label="MQTT 密码" value={issued.mqtt_password} onCopy={copy} monospace />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} variant="contained">
              我已保存
            </Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}

function Row({
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
        <IconButton size="small" onClick={() => onCopy(value)} aria-label={`复制${label}`}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}
