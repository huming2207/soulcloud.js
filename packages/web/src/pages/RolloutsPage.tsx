import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Placeholder } from "./Placeholder";

export function RolloutsPage() {
  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        OTA 升级
      </Typography>
      <Placeholder
        title="分批升级（P3）"
        description="创建 auto / grouped 策略的升级批次，跟踪分阶段进度并控制暂停/恢复/中止/回滚。"
      />
    </Stack>
  );
}
