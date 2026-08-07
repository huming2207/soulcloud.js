import { useMemo, useState, type FormEvent } from "react";
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
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import { fetchDevices } from "../api/devices";
import { createRollout, fetchReleases } from "../api/firmware";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";
import type { DeviceSummary, RolloutStrategy } from "../api/types";
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

const DEFAULT_RATIOS = [0.05, 0.25, 1.0];

function toOptions(devices: DeviceSummary[]): DeviceOption[] {
  return devices.map((d) => ({
    device_id: d.device_id,
    label: `${d.assigned_id} · ${d.device_uid}`,
  }));
}

function DeviceMultiSelect({
  options,
  value,
  onChange,
  label,
}: {
  options: DeviceOption[];
  value: DeviceOption[];
  onChange: (v: DeviceOption[]) => void;
  label: string;
}) {
  return (
    <Autocomplete
      multiple
      options={options}
      value={value}
      onChange={(_, v) => onChange(v)}
      disableCloseOnSelect
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(a, b) => a.device_id === b.device_id}
      renderOption={(props, option, { selected }) => (
        <li {...props}>
          <Checkbox
            icon={<CheckBoxOutlineBlankIcon fontSize="small" />}
            checkedIcon={<CheckBoxIcon fontSize="small" />}
            checked={selected}
          />
          <Box component="span" sx={{ fontFamily: "monospace", fontSize: 13 }}>
            {option.label}
          </Box>
        </li>
      )}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

/**
 * Rollout creation wizard: strategy (auto ratios vs grouped device sets),
 * gating parameters, optional rollback baseline. Navigates to the rollout
 * detail page on success.
 */
export function RolloutCreateDialog({ releaseId, open, onClose }: Props) {
  const { t } = useI18n();
  const { projectId } = useProject();
  const navigate = useNavigate();

  const devices = useQuery({
    queryKey: ["devices", projectId, 0, 500],
    queryFn: () => fetchDevices(projectId ?? "", { limit: 500, offset: 0 }),
    enabled: open && Boolean(projectId),
  });
  const releases = useQuery({
    queryKey: ["releases", projectId, null],
    queryFn: () => fetchReleases(projectId ?? "", { limit: 100 }),
    enabled: open && Boolean(projectId),
  });

  const options = useMemo(
    () => toOptions(devices.data?.devices ?? []),
    [devices.data],
  );
  const baselineOptions = useMemo(
    () =>
      (releases.data?.items ?? [])
        .filter((r) => r.release_id !== releaseId)
        .map((r) => ({
          release_id: r.release_id,
          label: `${r.version ?? t("rollout.unnamed")} · ${r.release_id.slice(0, 8)}`,
        })),
    [releases.data, releaseId],
  );

  const [strategy, setStrategy] = useState<RolloutStrategy>("auto");
  const [pool, setPool] = useState<DeviceOption[]>([]);
  const [ratios, setRatios] = useState<number[]>([...DEFAULT_RATIOS]);
  const [groups, setGroups] = useState<DeviceOption[][]>([[]]);
  const [fromReleaseId, setFromReleaseId] = useState("");
  const [successRatio, setSuccessRatio] = useState("0.9");
  const [minSample, setMinSample] = useState("10");
  const [phaseTimeout, setPhaseTimeout] = useState("24");
  const [stuckHours, setStuckHours] = useState("6");
  const [manualApproval, setManualApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    setError(null);
    setSubmitting(false);
    onClose();
  };

  const updateRatio = (index: number, raw: string) => {
    const next = [...ratios];
    next[index] = Number(raw);
    setRatios(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const numericGating = {
      success_ratio: Number(successRatio),
      min_sample: Number(minSample),
      phase_timeout_hours: Number(phaseTimeout),
      stuck_hours: Number(stuckHours),
    };
    for (const [name, v] of Object.entries(numericGating)) {
      if (!Number.isFinite(v) || v <= 0) {
        setError(t("rollout.create.errPositive", { name }));
        return;
      }
    }
    const gating = { ...numericGating, manual_approval: manualApproval };
    if (strategy === "auto") {
      if (ratios.length === 0 || ratios.some((r) => !(r > 0 && r <= 1))) {
        setError(t("rollout.create.errRatios"));
        return;
      }
      for (let i = 1; i < ratios.length; i++) {
        if (ratios[i]! <= ratios[i - 1]!) {
          setError(t("rollout.create.errAscending"));
          return;
        }
      }
      if (ratios[ratios.length - 1] !== 1) {
        setError(t("rollout.create.errLast"));
        return;
      }
      if (pool.length === 0) {
        setError(t("rollout.create.errPool"));
        return;
      }
    } else {
      const nonEmpty = groups.filter((g) => g.length > 0);
      if (nonEmpty.length === 0) {
        setError(t("rollout.create.errGroup"));
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await createRollout(releaseId, {
        strategy,
        ...(strategy === "auto"
          ? {
              device_ids: pool.map((d) => d.device_id),
              ratios,
            }
          : {
              phases: groups
                .filter((g) => g.length > 0)
                .map((g) => ({ device_ids: g.map((d) => d.device_id) })),
            }),
        ...(fromReleaseId ? { from_release_id: fromReleaseId } : {}),
        ...gating,
      });
      handleClose();
      navigate(`/rollouts/${res.rollout_id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle>{t("rollout.create.title")}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {t("rollout.create.body")}
          </DialogContentText>
          <Stack spacing={2.5}>
            {error && <Alert severity="error">{error}</Alert>}

            <RadioGroup
              row
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as RolloutStrategy)}
            >
              <FormControlLabel value="auto" control={<Radio />} label={t("rollout.create.auto")} />
              <FormControlLabel value="grouped" control={<Radio />} label={t("rollout.create.grouped")} />
            </RadioGroup>

            {strategy === "auto" ? (
              <>
                <DeviceMultiSelect
                  options={options}
                  value={pool}
                  onChange={setPool}
                  label={t("rollout.create.pool")}
                />
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    {t("rollout.create.ratios")}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
                    {ratios.map((r, i) => (
                      <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <TextField
                          size="small"
                          type="number"
                          slotProps={{
                            htmlInput: {
                              step: 0.05,
                              min: 0,
                              max: 1,
                              "aria-label": t("rollout.create.ratioLabel", { n: i + 1 }),
                            },
                          }}
                          value={Number.isFinite(r) ? r : ""}
                          onChange={(e) => updateRatio(i, e.target.value)}
                          sx={{ width: 90 }}
                        />
                        <IconButton
                          size="small"
                          disabled={ratios.length <= 1}
                          onClick={() => setRatios(ratios.filter((_, j) => j !== i))}
                          aria-label={t("rollout.deleteRatio")}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    ))}
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      disabled={ratios.length >= 10}
                      onClick={() => setRatios([...ratios, 1])}
                    >
                      {t("rollout.create.addRatio")}
                    </Button>
                  </Stack>
                </Box>
              </>
            ) : (
              <Stack spacing={2}>
                {groups.map((g, i) => (
                  <Stack key={i} direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                    <Box sx={{ flexGrow: 1 }}>
                      <DeviceMultiSelect
                        options={options}
                        value={g}
                        onChange={(v) =>
                          setGroups(groups.map((prev, j) => (j === i ? v : prev)))
                        }
                        label={t("rollout.create.groupN", { n: i + 1 })}
                      />
                    </Box>
                    <IconButton
                      size="small"
                      disabled={groups.length <= 1}
                      onClick={() => setGroups(groups.filter((_, j) => j !== i))}
                      aria-label={t("rollout.deleteGroup")}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                <Box>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    disabled={groups.length >= 10}
                    onClick={() => setGroups([...groups, []])}
                  >
                    {t("rollout.create.addGroup")}
                  </Button>
                </Box>
              </Stack>
            )}

            <TextField
              select
              label={t("rollout.create.baseline")}
              value={fromReleaseId}
              onChange={(e) => setFromReleaseId(e.target.value)}
              helperText={t("rollout.create.baselineHint")}
              fullWidth
            >
              <MenuItem value="">
                <em>{t("rollout.create.none")}</em>
              </MenuItem>
              {baselineOptions.map((b) => (
                <MenuItem key={b.release_id} value={b.release_id}>
                  {b.label}
                </MenuItem>
              ))}
            </TextField>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                {t("rollout.create.gating")}
              </Typography>
              <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap" }} useFlexGap>
                <TextField
                  label={t("rollout.create.successRatio")}
                  type="number"
                  size="small"
                  slotProps={{ htmlInput: { step: 0.05, min: 0, max: 1 } }}
                  value={successRatio}
                  onChange={(e) => setSuccessRatio(e.target.value)}
                  sx={{ width: 150 }}
                />
                <TextField
                  label={t("rollout.create.minSample")}
                  type="number"
                  size="small"
                  slotProps={{ htmlInput: { min: 0 } }}
                  value={minSample}
                  onChange={(e) => setMinSample(e.target.value)}
                  sx={{ width: 130 }}
                />
                <TextField
                  label={t("rollout.create.phaseTimeout")}
                  type="number"
                  size="small"
                  slotProps={{ htmlInput: { min: 1 } }}
                  value={phaseTimeout}
                  onChange={(e) => setPhaseTimeout(e.target.value)}
                  sx={{ width: 140 }}
                />
                <TextField
                  label={t("rollout.create.stuckHours")}
                  type="number"
                  size="small"
                  slotProps={{ htmlInput: { min: 1 } }}
                  value={stuckHours}
                  onChange={(e) => setStuckHours(e.target.value)}
                  sx={{ width: 140 }}
                />
              </Stack>
              <FormControlLabel
                control={
                  <Switch
                    checked={manualApproval}
                    onChange={(e) => setManualApproval(e.target.checked)}
                  />
                }
                label={t("rollout.create.manualApproval")}
                sx={{ mt: 1 }}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>{t("rollout.create.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting ? t("rollout.create.creating") : t("rollout.create.submit")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
