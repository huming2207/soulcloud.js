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
import { zhCN } from "@mui/x-data-grid/locales";
import { fetchDevices } from "../api/devices";
import { useProject } from "../layout/ProjectContext";
import { NewDeviceDialog } from "../components/NewDeviceDialog";

const PAGE_SIZES = [25, 50, 100];

export function DevicesPage() {
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
      { field: "assigned_id", headerName: "assigned_id", flex: 1, minWidth: 160 },
      {
        field: "device_uid",
        headerName: "device_uid",
        flex: 1,
        minWidth: 200,
        renderCell: (params) => (
          <Box sx={{ fontFamily: "monospace", fontSize: 13 }}>{params.value}</Box>
        ),
      },
      {
        field: "fw_hash",
        headerName: "固件",
        width: 220,
        renderCell: (params) =>
          params.value ? (
            <Tooltip
              title={
                params.row.fw_reported_at
                  ? `上报于 ${new Date(params.row.fw_reported_at).toLocaleString("zh-CN")}`
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
        headerName: "凭据",
        width: 110,
        renderCell: (params) =>
          params.value ? (
            <Chip size="small" label="已吊销" color="error" variant="outlined" />
          ) : (
            <Chip size="small" label="正常" color="success" variant="outlined" />
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
            详情
          </Button>
        ),
      },
    ],
    [navigate],
  );

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          设备
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setNewDeviceOpen(true)}
        >
          新建设备
        </Button>
      </Stack>

      {devices.data?.total === 0 && (
        <Alert severity="info">
          项目里还没有设备——点击右上角「新建设备」录入第一台设备（device_uid
          需与硬件侧保持一致）。
        </Alert>
      )}

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
          localeText={zhCN.components.MuiDataGrid.defaultProps.localeText}
          density="compact"
          disableRowSelectionOnClick
        />
      </Box>

      <NewDeviceDialog
        open={newDeviceOpen}
        onClose={() => setNewDeviceOpen(false)}
        onCreated={() => devices.refetch()}
      />
    </Stack>
  );
}
