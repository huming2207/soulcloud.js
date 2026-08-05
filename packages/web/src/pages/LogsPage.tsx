import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { fetchDevices } from "../api/devices";
import { LogsView } from "../components/LogsView";
import { useProject } from "../layout/ProjectContext";

export function LogsPage() {
  const { projectId } = useProject();
  const [deviceId, setDeviceId] = useState<string>("");

  const devices = useQuery({
    queryKey: ["devices", projectId, 0, 100],
    queryFn: () => fetchDevices(projectId ?? "", { limit: 100, offset: 0 }),
    enabled: Boolean(projectId),
  });

  const list = devices.data?.devices ?? [];

  // keep the selection valid when the project changes
  const selected = list.find((d) => d.device_id === deviceId) ?? null;

  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        日志
      </Typography>

      <TextField
        select
        label="设备"
        value={selected?.device_id ?? ""}
        onChange={(e) => setDeviceId(e.target.value)}
        disabled={devices.isLoading || list.length === 0}
        sx={{ maxWidth: 420 }}
        helperText={list.length === 0 ? "该项目暂无设备" : undefined}
      >
        {list.map((d) => (
          <MenuItem key={d.device_id} value={d.device_id}>
            {d.assigned_id} · {d.device_uid}
          </MenuItem>
        ))}
      </TextField>

      {selected ? (
        <LogsView deviceId={selected.device_id} />
      ) : (
        <Alert severity="info">选择一台设备查看解码后的日志流</Alert>
      )}
    </Stack>
  );
}
