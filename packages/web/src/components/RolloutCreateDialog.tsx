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
          label: `${r.version ?? "（未命名）"} · ${r.release_id.slice(0, 8)}`,
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
        setError(`${name} 必须是正数`);
        return;
      }
    }
    const gating = { ...numericGating, manual_approval: manualApproval };
    if (strategy === "auto") {
      if (ratios.length === 0 || ratios.some((r) => !(r > 0 && r <= 1))) {
        setError("每个比率必须是 (0, 1] 内的数值");
        return;
      }
      for (let i = 1; i < ratios.length; i++) {
        if (ratios[i]! <= ratios[i - 1]!) {
          setError("比率必须严格递增，且最后一项为 1");
          return;
        }
      }
      if (ratios[ratios.length - 1] !== 1) {
        setError("最后一项比率必须为 1（覆盖全部设备）");
        return;
      }
      if (pool.length === 0) {
        setError("请选择目标设备");
        return;
      }
    } else {
      const nonEmpty = groups.filter((g) => g.length > 0);
      if (nonEmpty.length === 0) {
        setError("至少需要一组设备");
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
        <DialogTitle>创建分批升级</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            分批部署固件：可按比例自动分批（auto）或按自定义分组（grouped）。
          </DialogContentText>
          <Stack spacing={2.5}>
            {error && <Alert severity="error">{error}</Alert>}

            <RadioGroup
              row
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as RolloutStrategy)}
            >
              <FormControlLabel value="auto" control={<Radio />} label="自动分批（按比率）" />
              <FormControlLabel value="grouped" control={<Radio />} label="自定义分组" />
            </RadioGroup>

            {strategy === "auto" ? (
              <>
                <DeviceMultiSelect
                  options={options}
                  value={pool}
                  onChange={setPool}
                  label="目标设备池（全部分批的总集合）"
                />
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    阶段比率（递增，末项 = 1）
                  </Typography>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    {ratios.map((r, i) => (
                      <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <TextField
                          size="small"
                          type="number"
                          inputProps={{ step: 0.05, min: 0, max: 1 }}
                          value={Number.isFinite(r) ? r : ""}
                          onChange={(e) => updateRatio(i, e.target.value)}
                          sx={{ width: 90 }}
                        />
                        <IconButton
                          size="small"
                          disabled={ratios.length <= 1}
                          onClick={() => setRatios(ratios.filter((_, j) => j !== i))}
                          aria-label="删除比率"
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
                      添加
                    </Button>
                  </Stack>
                </Box>
              </>
            ) : (
              <Stack spacing={2}>
                {groups.map((g, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
                    <Box sx={{ flexGrow: 1 }}>
                      <DeviceMultiSelect
                        options={options}
                        value={g}
                        onChange={(v) =>
                          setGroups(groups.map((prev, j) => (j === i ? v : prev)))
                        }
                        label={`第 ${i + 1} 组`}
                      />
                    </Box>
                    <IconButton
                      size="small"
                      disabled={groups.length <= 1}
                      onClick={() => setGroups(groups.filter((_, j) => j !== i))}
                      aria-label="删除分组"
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
                    添加分组
                  </Button>
                </Box>
              </Stack>
            )}

            <TextField
              select
              label="回滚基线（可选）"
              value={fromReleaseId}
              onChange={(e) => setFromReleaseId(e.target.value)}
              helperText="设置后可在升级完成后一键回滚到此版本"
              fullWidth
            >
              <MenuItem value="">
                <em>无</em>
              </MenuItem>
              {baselineOptions.map((b) => (
                <MenuItem key={b.release_id} value={b.release_id}>
                  {b.label}
                </MenuItem>
              ))}
            </TextField>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                推进门槛
              </Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                <TextField
                  label="成功率（success_ratio）"
                  type="number"
                  size="small"
                  inputProps={{ step: 0.05, min: 0, max: 1 }}
                  value={successRatio}
                  onChange={(e) => setSuccessRatio(e.target.value)}
                  sx={{ width: 150 }}
                />
                <TextField
                  label="最小样本（min_sample）"
                  type="number"
                  size="small"
                  inputProps={{ min: 0 }}
                  value={minSample}
                  onChange={(e) => setMinSample(e.target.value)}
                  sx={{ width: 130 }}
                />
                <TextField
                  label="阶段超时（小时）"
                  type="number"
                  size="small"
                  inputProps={{ min: 1 }}
                  value={phaseTimeout}
                  onChange={(e) => setPhaseTimeout(e.target.value)}
                  sx={{ width: 140 }}
                />
                <TextField
                  label="卡住判定（小时）"
                  type="number"
                  size="small"
                  inputProps={{ min: 1 }}
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
                label="每阶段手动批准"
                sx={{ mt: 1 }}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>取消</Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting ? "创建中…" : "创建升级"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
