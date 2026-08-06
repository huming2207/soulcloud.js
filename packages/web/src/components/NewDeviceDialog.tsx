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

const UID_HELP =
  "硬件上报的唯一标识，也是 MQTT 连接的用户名；不能包含 / + # 或空白字符";

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
          <DialogTitle>设备已创建</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>
              凭据仅显示这一次，请立即保存并配置到设备。
            </Alert>
            <Stack spacing={1}>
              <CredentialRow
                label="MQTT 用户名"
                value={credential.mqtt_username}
                onCopy={copy}
              />
              <CredentialRow
                label="MQTT 密码"
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
              我已保存
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <DialogTitle>新建设备</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              设备通过 MQTT 连接（用户名 = device_uid）。创建后颁发一次性密码。
            </DialogContentText>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                label="assigned_id（人类可读标识）"
                value={assignedId}
                onChange={(e) => setAssignedId(e.target.value)}
                required
                fullWidth
                autoFocus
                helperText="项目内唯一，例如温控器-客厅-01"
              />
              <TextField
                label="device_uid（硬件标识）"
                value={deviceUid}
                onChange={(e) => setDeviceUid(e.target.value)}
                required
                fullWidth
                helperText={UID_HELP}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>取消</Button>
            <Button type="submit" variant="contained" disabled={submitting}>
              {submitting ? "创建中…" : "创建"}
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
