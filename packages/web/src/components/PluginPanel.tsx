import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import {
  fetchDeviceActions,
  fetchPluginView,
  invokeDeviceAction,
  type ActionView,
  type EntityDescriptorView,
  type EntityStateView,
} from "../api/plugins";
import { errorMessage } from "../api/http";
import { CardSkeleton, QueryError } from "./QueryState";
import { useI18n } from "../i18n/I18nContext";

/**
 * Declarative plugin panel (§7.1): renders entity states and action forms
 * purely from the plugin manifest's descriptors — no plugin front-end code
 * is executed here.
 */
export function PluginPanel({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const view = useQuery({
    queryKey: ["plugin-view", deviceId],
    queryFn: () => fetchPluginView(deviceId),
    refetchInterval: 10_000,
  });
  const actions = useQuery({
    queryKey: ["device-actions", deviceId],
    queryFn: () => fetchDeviceActions(deviceId),
  });

  if (view.isLoading || actions.isLoading) return <CardSkeleton />;
  if (view.error) return <QueryError error={view.error} onRetry={() => view.refetch()} />;
  const data = view.data;
  if (!data) return null;

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
            {t("plugin.binding")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {data.binding.plugin_id}
            {data.binding.plugin_version ? ` @ ${data.binding.plugin_version}` : ""}
            {" · "}
            {data.binding.profile_id} v{data.binding.profile_version}
          </Typography>
        </CardContent>
      </Card>

      {data.entities.length > 0 && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
              {t("plugin.entities")}
            </Typography>
            <Stack spacing={1}>
              {data.entities.map(({ descriptor, state }) => (
                <EntityRow key={descriptor.key} descriptor={descriptor} state={state} />
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}

      {(actions.data?.actions.length ?? 0) > 0 && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
              {t("plugin.actions")}
            </Typography>
            <Stack spacing={2}>
              {actions.data!.actions.map((action) => (
                <ActionForm key={action.id} deviceId={deviceId} action={action} />
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function qualityColor(quality: string): "success" | "error" | "warning" | "default" {
  if (quality === "good") return "success";
  if (quality === "bad") return "error";
  if (quality === "uncertain" || quality === "stale") return "warning";
  return "default";
}

function formatValue(
  descriptor: EntityDescriptorView,
  state: EntityStateView | null,
  noValueLabel: string,
  binaryLabel: string,
): string {
  if (!state || state.ingestedAt === null) return noValueLabel;
  if (descriptor.value_type === "binary") return binaryLabel;
  const value = state.value;
  if (value === null || value === undefined) return "—";
  const unitSuffix = descriptor.unit ? ` ${descriptor.unit}` : "";
  return `${String(value)}${unitSuffix}`;
}

function EntityRow({
  descriptor,
  state,
}: {
  descriptor: EntityDescriptorView;
  state: EntityStateView | null;
}) {
  const { t } = useI18n();
  const label = descriptor.display_name ?? descriptor.key;
  const stale =
    descriptor.stale_after_seconds !== null &&
    state?.sourceTimestamp !== undefined &&
    state?.sourceTimestamp !== null &&
    Date.now() - new Date(state.sourceTimestamp).getTime() >
      descriptor.stale_after_seconds * 1000;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
      <Typography variant="body2" sx={{ minWidth: 180 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
        {formatValue(descriptor, state, t("plugin.noValue"), t("plugin.binaryValue"))}
      </Typography>
      <Chip
        size="small"
        variant="outlined"
        label={state ? state.quality : "unknown"}
        color={qualityColor(state?.quality ?? "unknown")}
      />
      {state?.alarmLevel && (
        <Chip
          size="small"
          label={`${state.alarmLevel}: ${state.alarmCode ?? ""}`}
          color={state.alarmLevel === "critical" ? "error" : "warning"}
        />
      )}
      {stale && (
        <Chip size="small" variant="outlined" label={t("plugin.stale")} color="warning" />
      )}
    </Box>
  );
}

function ActionForm({ deviceId, action }: { deviceId: string; action: ActionView }) {
  const { t } = useI18n();
  const fields = Object.entries(action.input_schema);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [name, field] of fields) {
      initial[name] = field.default !== undefined ? String(field.default) : "";
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const invoke = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const input: Record<string, unknown> = {};
      for (const [name, field] of fields) {
        const raw = values[name];
        if (raw === "" || raw === undefined) continue;
        if (field.type === "number" || field.type === "integer") {
          input[name] = Number(raw);
        } else if (field.type === "boolean") {
          input[name] = raw === "true";
        } else {
          input[name] = raw;
        }
      }
      const res = await invokeDeviceAction(deviceId, action.id, input);
      setDone(t("plugin.actionQueued", { batch: res.batch_id.slice(0, 8) }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {action.id}
        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          {action.wire_command}
        </Typography>
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        {fields.map(([name, field]) => {
          const label = field.title ?? name;
          if (field.enum) {
            return (
              <TextField
                key={name}
                select
                size="small"
                label={label}
                value={values[name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                sx={{ minWidth: 160 }}
              >
                {field.enum.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </TextField>
            );
          }
          return (
            <TextField
              key={name}
              size="small"
              label={label + (field.required ? " *" : "")}
              type={field.type === "boolean" ? "text" : field.type === "string" ? "text" : "number"}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              slotProps={{
                htmlInput:
                  field.type === "integer"
                    ? { step: 1 }
                    : field.type === "number"
                      ? { step: "any", min: field.min, max: field.max }
                      : undefined,
              }}
              sx={{ minWidth: 140 }}
            />
          );
        })}
        <Button size="small" variant="contained" onClick={() => void invoke()} disabled={busy}>
          {busy ? t("plugin.invoking") : t("plugin.invoke")}
        </Button>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {done && (
        <Alert severity="success" sx={{ mt: 1 }}>
          {done}
        </Alert>
      )}
    </Box>
  );
}
