import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useAuth } from "../auth/AuthContext";
import { useProject } from "../layout/ProjectContext";
import { Placeholder } from "./Placeholder";
import { CardSkeleton } from "../components/QueryState";
import { useI18n } from "../i18n/I18nContext";

export function DashboardPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { project } = useProject();

  return (
    <Stack spacing={3}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        {t("dash.title")}
      </Typography>
      {project ? (
        <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap" }} useFlexGap>
          <Card sx={{ minWidth: 240, flex: "1 1 240px" }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {t("dash.currentProject")}
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
                {t("dash.totalDevices")}
              </Typography>
              <Typography variant="h6">{project.device_count}</Typography>
            </CardContent>
          </Card>
        </Stack>
      ) : (
        <CardSkeleton />
      )}
      <Placeholder
        title={t("dash.roadmap")}
        description={
          <>
            {t("dash.welcome", { name: user?.username ?? "" })}
          </>
        }
      />
    </Stack>
  );
}
