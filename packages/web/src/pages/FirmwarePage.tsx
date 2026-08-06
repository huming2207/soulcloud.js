import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DownloadIcon from "@mui/icons-material/Download";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import { fetchArtifacts, fetchReleases, triggerReleaseDownload } from "../api/firmware";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";
import { DeployDialog } from "../components/DeployDialog";
import { UploadDialog } from "../components/UploadDialog";
import { RolloutCreateDialog } from "../components/RolloutCreateDialog";
import { ListSkeleton, QueryError } from "../components/QueryState";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false });
}

export function FirmwarePage() {
  const { projectId } = useProject();
  const [tab, setTab] = useState(0);
  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        固件
      </Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v as number)}>
        <Tab label="发布" />
        <Tab label="ELF 构件" />
      </Tabs>
      {tab === 0 && <ReleasesTab projectId={projectId} />}
      {tab === 1 && <ArtifactsTab projectId={projectId} />}
    </Stack>
  );
}

function ReleasesTab({ projectId }: { projectId: string | null }) {
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deployReleaseId, setDeployReleaseId] = useState<string | null>(null);
  const [rolloutReleaseId, setRolloutReleaseId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const releases = useQuery({
    queryKey: ["releases", projectId, cursor],
    queryFn: () => fetchReleases(projectId ?? "", { limit: 50, cursor: cursor ?? undefined }),
    enabled: Boolean(projectId),
  });

  const rows = releases.data?.items ?? [];

  const download = async (releaseId: string, version: string | null) => {
    setActionError(null);
    try {
      await triggerReleaseDownload(
        releaseId,
        `release-${version ?? releaseId.slice(0, 8)}.bin`,
      );
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setUploadOpen(true)}
        >
          上传发布
        </Button>
        {actionError && (
          <Typography variant="body2" color="error">
            {actionError}
          </Typography>
        )}
      </Stack>

      {releases.isLoading ? (
        <ListSkeleton />
      ) : releases.error ? (
        <QueryError error={releases.error} onRetry={() => releases.refetch()} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>版本</TableCell>
              <TableCell>大小</TableCell>
              <TableCell>bin_hash</TableCell>
              <TableCell>ELF 构件</TableCell>
              <TableCell>创建时间</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !releases.isLoading && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ color: "text.secondary" }}>
                  暂无发布
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.release_id} hover>
                <TableCell sx={{ fontWeight: 600 }}>
                  {r.version ?? "（未命名）"}
                </TableCell>
                <TableCell>{formatSize(r.bin_size)}</TableCell>
                <TableCell>
                  <Tooltip title={r.bin_hash}>
                    <Box sx={{ fontFamily: "monospace", fontSize: 12 }}>
                      {r.bin_hash.slice(0, 12)}…
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  {r.artifact_id ? (
                    <Chip size="small" label="已关联" color="success" variant="outlined" />
                  ) : (
                    <Box sx={{ color: "text.disabled" }}>—</Box>
                  )}
                </TableCell>
                <TableCell>{formatTime(r.created_at)}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} sx={{justifyContent: "flex-end"}}>
                    <Tooltip title="部署到设备">
                      <IconButton
                        size="small"
                        onClick={() => setDeployReleaseId(r.release_id)}
                      >
                        <RocketLaunchIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="创建分批升级">
                      <IconButton
                        size="small"
                        onClick={() => setRolloutReleaseId(r.release_id)}
                      >
                        <AddIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="下载 bin">
                      <IconButton
                        size="small"
                        onClick={() => download(r.release_id, r.version)}
                      >
                        <DownloadIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      )}

      <Stack direction="row"  spacing={1} sx={{justifyContent: "flex-end"}}>
        {releases.data?.next_cursor && (
          <Button size="small" onClick={() => setCursor(releases.data.next_cursor)}>
            加载更早
          </Button>
        )}
        {cursor && (
          <Button size="small" onClick={() => setCursor(null)}>
            回到最新
          </Button>
        )}
      </Stack>

      <UploadDialog
        kind="release"
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() =>
          queryClient.invalidateQueries({ queryKey: ["releases", projectId] })
        }
      />
      {deployReleaseId && (
        <DeployDialog
          releaseId={deployReleaseId}
          open
          onClose={() => setDeployReleaseId(null)}
        />
      )}
      {rolloutReleaseId && (
        <RolloutCreateDialog
          releaseId={rolloutReleaseId}
          open
          onClose={() => setRolloutReleaseId(null)}
        />
      )}
    </Stack>
  );
}

function ArtifactsTab({ projectId }: { projectId: string | null }) {
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);

  const artifacts = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: () => fetchArtifacts(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const rows = artifacts.data?.artifacts ?? [];

  return (
    <Stack spacing={2}>
      <Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setUploadOpen(true)}
        >
          上传 ELF 构件
        </Button>
      </Box>
      {artifacts.isLoading ? (
        <ListSkeleton />
      ) : artifacts.error ? (
        <QueryError error={artifacts.error} onRetry={() => artifacts.refetch()} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>版本</TableCell>
              <TableCell>build_id</TableCell>
              <TableCell>大小</TableCell>
              <TableCell>字典条目</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>上传时间</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !artifacts.isLoading && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ color: "text.secondary" }}>
                  暂无构件
                </TableCell>
              </TableRow>
            )}
            {rows.map((a) => (
              <TableRow key={a.artifact_id} hover>
                <TableCell sx={{ fontWeight: 600 }}>
                  {a.version ?? "（未命名）"}
                </TableCell>
                <TableCell>
                  <Tooltip title={a.build_id}>
                    <Box sx={{ fontFamily: "monospace", fontSize: 12 }}>
                      {a.build_id.slice(0, 12)}…
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell>{formatSize(a.elf_size)}</TableCell>
                <TableCell>{a.dictionary_entries}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={a.import_state}
                    color={a.import_state === "imported" ? "success" : "warning"}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>{formatTime(a.uploaded_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      )}
      <UploadDialog
        kind="artifact"
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() =>
          queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] })
        }
      />
    </Stack>
  );
}
