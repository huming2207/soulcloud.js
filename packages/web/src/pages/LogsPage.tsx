import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { fetchDevices } from "../api/devices";
import { LogsView } from "../components/LogsView";
import { QueryError } from "../components/QueryState";
import { useProject } from "../layout/ProjectContext";
import { useI18n } from "../i18n/I18nContext";

export function LogsPage() {
  const { t } = useI18n();
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
        {t("logs.title")}
      </Typography>

      {devices.error && (
        <QueryError error={devices.error} onRetry={() => devices.refetch()} />
      )}
      <TextField
        select
        label={t("logs.device")}
        value={selected?.device_id ?? ""}
        onChange={(e) => setDeviceId(e.target.value)}
        disabled={devices.isLoading || list.length === 0}
        sx={{ maxWidth: 420 }}
        helperText={list.length === 0 ? t("logs.noDevices") : undefined}
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
        <Alert severity="info">{t("logs.selectDevice")}</Alert>
      )}
    </Stack>
  );
}
