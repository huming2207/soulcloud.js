import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Placeholder } from "./Placeholder";

export function FirmwarePage() {
  return (
    <Stack spacing={2}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        固件
      </Typography>
      <Placeholder
        title="固件与发布（P3）"
        description="ELF 构件上传（字典导入）、固件发布（bin + elf）、部署与 OTA 任务跟踪。"
      />
    </Stack>
  );
}
