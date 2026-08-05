import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useAuth } from "../auth/AuthContext";
import { useProject } from "../layout/ProjectContext";
import { Placeholder } from "./Placeholder";

export function DashboardPage() {
  const { user } = useAuth();
  const { project } = useProject();

  return (
    <Stack spacing={3}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        仪表盘
      </Typography>
      {project ? (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <Card sx={{ minWidth: 240, flex: "1 1 240px" }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                当前项目
              </Typography>
              <Typography variant="h6" noWrap>
                {project.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {project.project_id}
              </Typography>
            </CardContent>
          </Card>
          <Card sx={{ minWidth: 240, flex: "1 1 240px" }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                设备总数
              </Typography>
              <Typography variant="h6">{project.device_count}</Typography>
            </CardContent>
          </Card>
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          加载项目信息…
        </Typography>
      )}
      <Placeholder
        title="后续规划"
        description={
          <>
            欢迎，{user?.username}。设备管理（P2）与固件 / OTA（P3）页面正在
            开发中。
          </>
        }
      />
    </Stack>
  );
}
