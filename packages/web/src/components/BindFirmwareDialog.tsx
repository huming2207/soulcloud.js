import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { bindFirmwareState } from "../api/devices";
import { fetchArtifacts } from "../api/firmware";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";

interface Props {
  deviceId: string;
  open: boolean;
  onClose: () => void;
  onBound: () => void;
}

/** Binds a device's reported firmware hash to an ELF artifact (backfills
 * previously undecodable log events). */
export function BindFirmwareDialog({ deviceId, open, onClose, onBound }: Props) {
  const { projectId } = useProject();
  const artifacts = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: () => fetchArtifacts(projectId ?? ""),
    enabled: open && Boolean(projectId),
  });
  const [artifactId, setArtifactId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfilled, setBackfilled] = useState<number | null>(null);

  const handleClose = () => {
    setArtifactId("");
    setError(null);
    setBackfilled(null);
    onClose();
  };

  const submit = async () => {
    if (!artifactId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await bindFirmwareState(deviceId, artifactId);
      setBackfilled(res.backfilled_events);
      onBound();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const list = artifacts.data?.artifacts ?? [];

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>绑定固件构件</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          将设备上报的固件哈希关联到 ELF 构件，可解码此前无法解析的日志事件。
        </DialogContentText>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {backfilled !== null && (
            <Alert severity="success">
              绑定成功，已回填 {backfilled} 条日志事件。
            </Alert>
          )}
          <TextField
            select
            label="ELF 构件"
            value={artifactId}
            onChange={(e) => setArtifactId(e.target.value)}
            disabled={artifacts.isLoading}
            fullWidth
          >
            {list.length === 0 && (
              <MenuItem value="" disabled>
                该项目暂无构件（先在固件页上传 ELF）
              </MenuItem>
            )}
            {list.map((a) => (
              <MenuItem key={a.artifact_id} value={a.artifact_id}>
                {a.version ?? a.build_id.slice(0, 12)} · {a.build_id.slice(0, 12)}…
                ({a.dictionary_entries} 字典条目)
              </MenuItem>
            ))}
          </TextField>
          {list.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              仅显示版本号与构建 ID 前缀
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>取消</Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={submitting || !artifactId}
        >
          {submitting ? "绑定中…" : "绑定"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
