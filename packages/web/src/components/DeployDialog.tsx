import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import { fetchDevices } from "../api/devices";
import { deployRelease } from "../api/firmware";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";

interface DeviceOption {
  device_id: string;
  label: string;
}

interface Props {
  releaseId: string;
  open: boolean;
  onClose: () => void;
}

/** Deploys a release to selected devices (one OTA job). */
export function DeployDialog({ releaseId, open, onClose }: Props) {
  const { projectId } = useProject();
  const navigate = useNavigate();
  const devices = useQuery({
    queryKey: ["devices", projectId, 0, 500],
    queryFn: () => fetchDevices(projectId ?? "", { limit: 500, offset: 0 }),
    enabled: open && Boolean(projectId),
  });
  const [selected, setSelected] = useState<DeviceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const options: DeviceOption[] = (devices.data?.devices ?? []).map((d) => ({
    device_id: d.device_id,
    label: `${d.assigned_id} · ${d.device_uid}`,
  }));

  const reset = () => {
    setSelected([]);
    setError(null);
    setSubmitting(false);
    setJobId(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await deployRelease(
        releaseId,
        selected.map((s) => s.device_id),
      );
      setJobId(res.job_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      {jobId ? (
        <>
          <DialogTitle>部署已创建</DialogTitle>
          <DialogContent>
            <Alert severity="success" sx={{ mb: 2 }}>
              已为 {selected.length} 台设备创建 OTA 任务（{jobId}）。设备将收到
              下载通知，可在任务页跟踪进度。
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>关闭</Button>
            <Button
              variant="contained"
              onClick={() => {
                handleClose();
                navigate(`/ota-jobs/${jobId}`);
              }}
            >
              查看任务
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={submit}>
          <DialogTitle>部署固件</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              选择目标设备（最多 1000 台），每台设备会收到短时效的下载凭据。
            </DialogContentText>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <Autocomplete
                multiple
                options={options}
                value={selected}
                onChange={(_, value) => setSelected(value)}
                disableCloseOnSelect
                getOptionLabel={(o) => o.label}
                isOptionEqualToValue={(a, b) => a.device_id === b.device_id}
                renderOption={(props, option, { selected: isSelected }) => (
                  <li {...props}>
                    <Checkbox
                      icon={<CheckBoxOutlineBlankIcon fontSize="small" />}
                      checkedIcon={<CheckBoxIcon fontSize="small" />}
                      checked={isSelected}
                    />
                    <Box component="span" sx={{ fontFamily: "monospace", fontSize: 13 }}>
                      {option.label}
                    </Box>
                  </li>
                )}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="目标设备"
                    placeholder="选择设备…"
                    helperText={
                      devices.isLoading
                        ? "加载设备…"
                        : `共 ${devices.data?.total ?? 0} 台设备（最多展示前 500 台）`
                    }
                  />
                )}
              />
              {selected.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  已选择 {selected.length} 台
                </Typography>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>取消</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={submitting || selected.length === 0}
            >
              {submitting ? "创建中…" : "部署"}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
