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
import { useI18n } from "../i18n/I18nContext";

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
  const { t } = useI18n();
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
          <DialogTitle>{t("deploy.done")}</DialogTitle>
          <DialogContent>
            <Alert severity="success" sx={{ mb: 2 }}>
              {t("deploy.doneBody", { count: selected.length, id: jobId })}
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>{t("deploy.close")}</Button>
            <Button
              variant="contained"
              onClick={() => {
                handleClose();
                navigate(`/ota-jobs/${jobId}`);
              }}
            >
              {t("deploy.viewJob")}
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={submit}>
          <DialogTitle>{t("deploy.title")}</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              {t("deploy.body")}
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
                    label={t("deploy.devices")}
                    placeholder={t("deploy.placeholder")}
                    helperText={
                      devices.isLoading
                        ? t("deploy.loadingDevices")
                        : t("deploy.deviceCount", { total: devices.data?.total ?? 0 })
                    }
                  />
                )}
              />
              {selected.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  {t("deploy.selected", { count: selected.length })}
                </Typography>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>{t("upload.cancel")}</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={submitting || selected.length === 0}
            >
              {submitting ? t("deploy.deploying") : t("deploy.submit")}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
