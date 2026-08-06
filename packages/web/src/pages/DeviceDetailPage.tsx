import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { fetchDevice, fetchDeviceFirmwareState, revokeCredentials } from "../api/devices";
import { errorMessage } from "../api/http";
import { BindFirmwareDialog } from "../components/BindFirmwareDialog";
import { CredentialsDialog } from "../components/CredentialsDialog";
import { CommandPanel } from "../components/CommandPanel";
import { LogsView } from "../components/LogsView";
import { CardSkeleton, QueryError } from "../components/QueryState";
import { useI18n } from "../i18n/I18nContext";

export function DeviceDetailPage() {
  const { t } = useI18n();
  const { deviceId } = useParams<{ deviceId: string }>();
  const [tab, setTab] = useState(0);
  if (!deviceId) return null;

  return (
    <Stack spacing={2}>
      <Tabs value={tab} onChange={(_, v) => setTab(v as number)}>
        <Tab label={t("detail.tabOverview")} />
        <Tab label={t("detail.tabCommands")} />
        <Tab label={t("detail.tabLogs")} />
      </Tabs>
      {tab === 0 && <OverviewTab deviceId={deviceId} />}
      {tab === 1 && <CommandPanel deviceId={deviceId} />}
      {tab === 2 && <LogsView deviceId={deviceId} />}
    </Stack>
  );
}

function OverviewTab({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const device = useQuery({
    queryKey: ["device", deviceId],
    queryFn: () => fetchDevice(deviceId),
  });
  const fwState = useQuery({
    queryKey: ["fw-state", deviceId],
    queryFn: async () => {
      try {
        return await fetchDeviceFirmwareState(deviceId);
      } catch (err) {
        // 404 = the device never reported firmware; treat as "no state"
        if (
          typeof err === "object" &&
          err !== null &&
          "response" in err &&
          (err as { response?: { status?: number } }).response?.status === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
  });

  const [bindOpen, setBindOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const d = device.data;

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["device", deviceId] });
    queryClient.invalidateQueries({ queryKey: ["fw-state", deviceId] });
  };

  const doRevoke = async () => {
    setRevokeError(null);
    setRevoking(true);
    try {
      await revokeCredentials(deviceId);
      setRevokeOpen(false);
      refreshAll();
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

  if (device.isLoading) {
    return <CardSkeleton />;
  }
  if (!d) {
    return (
      <QueryError
        error={device.error}
        onRetry={() => device.refetch()}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
            {t("detail.deviceInfo")}
          </Typography>
          <InfoRow label="assigned_id" value={d.assigned_id} />
          <InfoRow label="device_uid" value={d.device_uid} monospace />
          <InfoRow label="project_id" value={d.project_id} monospace small />
          <InfoRow label={t("detail.nextSeq")} value={d.next_command_sequence} monospace />
          <InfoRow
            label="凭据"
            value={
              d.auth_revoked ? (
                <Chip size="small" label="已吊销" color="error" variant="outlined" />
              ) : (
                <Chip size="small" label="正常" color="success" variant="outlined" />
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
            {t("detail.firmwareState")}
          </Typography>
          {fwState.data ? (
            <>
              <InfoRow label="fw_hash" value={fwState.data.fw_hash} monospace small />
              <InfoRow
                label={t("detail.artifactLinked")}
                value={
                  fwState.data.artifact_version
                    ? `${fwState.data.artifact_version}（${fwState.data.artifact_id?.slice(0, 8)}…）`
                    : t("detail.notLinked")
                }
              />
              <InfoRow
                label={t("detail.reportedAt")}
                value={new Date(fwState.data.reported_at).toLocaleString("zh-CN")}
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {t("detail.noFirmware")}
            </Typography>
          )}
          <Button size="small" variant="outlined" onClick={() => setBindOpen(true)}>
            {t("detail.bindArtifact")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
            {t("detail.credentials")}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t("detail.credentialsHint")}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={() => setCredentialsOpen(true)}>
              {t("detail.issue")}
            </Button>
            <Button size="small" variant="outlined" color="error" onClick={() => setRevokeOpen(true)}>
              {t("detail.revoke")}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <BindFirmwareDialog
        deviceId={deviceId}
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        onBound={refreshAll}
      />
      <CredentialsDialog
        deviceId={deviceId}
        open={credentialsOpen}
        onClose={() => setCredentialsOpen(false)}
        onIssued={refreshAll}
      />
      <Dialog open={revokeOpen} onClose={() => setRevokeOpen(false)}>
        <DialogTitle>{t("detail.revoke")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("detail.revokeBody")}
          </DialogContentText>
          {revokeError && <Alert severity="error" sx={{ mt: 2 }}>{revokeError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevokeOpen(false)}>取消</Button>
          <Button color="error" variant="contained" onClick={doRevoke} disabled={revoking}>
            {revoking ? t("detail.revoking") : t("detail.confirmRevoke")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function InfoRow({
  label,
  value,
  monospace = false,
  small = false,
}: {
  label: string;
  value: React.ReactNode;
  monospace?: boolean;
  small?: boolean;
}) {
  return (
    <Box sx={{ display: "flex", gap: 2, py: 0.5 }}>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ width: 130, flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Tooltip title={typeof value === "string" ? value : ""} placement="top">
        <Box
          sx={{
            fontFamily: monospace ? "monospace" : undefined,
            fontSize: small ? 12 : 14,
            wordBreak: "break-all",
            minWidth: 0,
          }}
        >
          {value}
        </Box>
      </Tooltip>
    </Box>
  );
}
