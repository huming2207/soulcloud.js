import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { DataGrid } from "@mui/x-data-grid";
import type { GridColDef, GridPaginationModel } from "@mui/x-data-grid";
import { fetchDevices } from "../api/devices";
import { useProject } from "../layout/ProjectContext";
import { NewDeviceDialog } from "../components/NewDeviceDialog";
import { QueryError } from "../components/QueryState";
import { useI18n } from "../i18n/I18nContext";

const PAGE_SIZES = [25, 50, 100];

export function DevicesPage() {
  const { t, gridLocaleText, locale } = useI18n();
  const { projectId } = useProject();
  const navigate = useNavigate();
  const [pagination, setPagination] = useState<GridPaginationModel>({
    page: 0,
    pageSize: 25,
  });
  const [newDeviceOpen, setNewDeviceOpen] = useState(false);

  // switching projects must not leave the page index out of range
  useEffect(() => {
    setPagination((p) => ({ ...p, page: 0 }));
  }, [projectId]);

  const devices = useQuery({
    queryKey: ["devices", projectId, pagination.page, pagination.pageSize],
    queryFn: () =>
      fetchDevices(projectId ?? "", {
        limit: pagination.pageSize,
        offset: pagination.page * pagination.pageSize,
      }),
    enabled: Boolean(projectId),
  });

  const rows = useMemo(
    () =>
      (devices.data?.devices ?? []).map((d) => ({
        id: d.device_id,
        device_uid: d.device_uid,
        assigned_id: d.assigned_id,
        auth_revoked: d.auth_revoked,
        fw_hash: d.firmware?.fw_hash ?? null,
        fw_reported_at: d.firmware?.reported_at ?? null,
      })),
    [devices.data],
  );

  const columns = useMemo<GridColDef[]>(
    () => [
      { field: "assigned_id", headerName: t("devices.colAssigned"), flex: 1, minWidth: 160 },
      {
        field: "device_uid",
        headerName: t("devices.colUid"),
        flex: 1,
        minWidth: 200,
        renderCell: (params) => (
          <Box sx={{ fontFamily: "monospace", fontSize: 13 }}>{params.value}</Box>
        ),
      },
      {
        field: "fw_hash",
        headerName: t("devices.colFirmware"),
        width: 220,
        renderCell: (params) =>
          params.value ? (
            <Tooltip
              title={
                params.row.fw_reported_at
                  ? t("devices.fwReportedAt", {
                      time: new Date(params.row.fw_reported_at).toLocaleString(locale),
                    })
                  : ""
              }
            >
              <Box sx={{ fontFamily: "monospace", fontSize: 12 }}>{params.value}</Box>
            </Tooltip>
          ) : (
            <Box sx={{ color: "text.disabled" }}>—</Box>
          ),
      },
      {
        field: "auth_revoked",
        headerName: t("devices.colCredential"),
        width: 110,
        renderCell: (params) =>
          params.value ? (
            <Chip size="small" label={t("devices.credRevoked")} color="error" variant="outlined" />
          ) : (
            <Chip size="small" label={t("devices.credActive")} color="success" variant="outlined" />
          ),
      },
      {
        field: "actions",
        headerName: "",
        width: 90,
        sortable: false,
        filterable: false,
        renderCell: (params) => (
          <Button
            size="small"
            onClick={() => navigate(`/devices/${params.id}`)}
          >
            {t("devices.details")}
          </Button>
        ),
      },
    ],
    [navigate, t],
  );

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          {t("devices.title")}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setNewDeviceOpen(true)}
        >
          {t("devices.new")}
        </Button>
      </Stack>

      {devices.isError && (
        <QueryError error={devices.error} onRetry={() => devices.refetch()} />
      )}

      {!devices.isError && devices.data?.total === 0 && (
        <Alert severity="info">
          {t("devices.empty")}
        </Alert>
      )}

      {!devices.isError && (
        <Box sx={{ height: 520 }}>
          <DataGrid
            rows={rows}
            columns={columns}
            rowCount={devices.data?.total ?? 0}
            paginationMode="server"
            paginationModel={pagination}
            onPaginationModelChange={(model) => setPagination(model)}
            pageSizeOptions={PAGE_SIZES}
            loading={devices.isLoading || devices.isFetching}
            localeText={gridLocaleText}
            density="compact"
            disableRowSelectionOnClick
          />
        </Box>
      )}

      <NewDeviceDialog
        open={newDeviceOpen}
        onClose={() => setNewDeviceOpen(false)}
        onCreated={() => devices.refetch()}
      />
    </Stack>
  );
}
