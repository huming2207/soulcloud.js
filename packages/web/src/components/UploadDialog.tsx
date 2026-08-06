import { useRef, useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { uploadArtifact, uploadRelease } from "../api/firmware";
import { errorMessage } from "../api/http";
import { useProject } from "../layout/ProjectContext";

interface Props {
  kind: "artifact" | "release";
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

/**
 * Shared upload dialog for both firmware artifacts (ELF only) and releases
 * (bin required, ELF optional). File picking is done with a hidden input;
 * MUI has no file-input component.
 */
export function UploadDialog({ kind, open, onClose, onUploaded }: Props) {
  const { projectId } = useProject();
  const [version, setVersion] = useState("");
  const [binFile, setBinFile] = useState<File | null>(null);
  const [elfFile, setElfFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const binInput = useRef<HTMLInputElement>(null);
  const elfInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setVersion("");
    setBinFile(null);
    setElfFile(null);
    setError(null);
    setResult(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      if (kind === "artifact") {
        if (!elfFile) {
          setError("请选择 ELF 文件");
          return;
        }
        const res = await uploadArtifact(
          projectId,
          elfFile,
          version.trim() || undefined,
        );
        setResult(
          `导入完成：${res.tag_count} 个 tag、${res.format_count} 个格式串，` +
            `回填 ${res.backfilled_events} 条日志事件。`,
        );
      } else {
        if (!binFile) {
          setError("请选择 bin 文件");
          return;
        }
        const res = await uploadRelease(
          projectId,
          { bin: binFile, elf: elfFile ?? undefined },
          version.trim() || undefined,
        );
        setResult(
          `发布成功${res.artifact_id ? "（已关联 ELF 构件）" : ""}，` +
            `bin ${res.bin_size} 字节。`,
        );
      }
      onUploaded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isRelease = kind === "release";

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle>{isRelease ? "上传固件发布" : "上传 ELF 构件"}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {isRelease
              ? "bin 为设备下载的固件镜像；可选附带 ELF 以关联构建身份（SHA-256 去重，重复上传返回已存在）。"
              : "ELF 用于提取 on9log 日志字典（tag / 格式串），按 SHA-256 去重。"}
          </DialogContentText>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            {result && <Alert severity="success">{result}</Alert>}
            <TextField
              label="版本号（可选，仅作参考）"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              fullWidth
            />
            {isRelease && (
              <FileField
                label="bin 文件（必选）"
                file={binFile}
                onPick={() => binInput.current?.click()}
                onClear={() => setBinFile(null)}
              />
            )}
            <FileField
              label={isRelease ? "ELF 文件（可选）" : "ELF 文件"}
              file={elfFile}
              onPick={() => elfInput.current?.click()}
              onClear={() => setElfFile(null)}
            />
            <input
              ref={binInput}
              type="file"
              hidden
              onChange={(e) => setBinFile(e.target.files?.[0] ?? null)}
            />
            <input
              ref={elfInput}
              type="file"
              hidden
              accept=".elf"
              onChange={(e) => setElfFile(e.target.files?.[0] ?? null)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>取消</Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting ? "上传中…" : "上传"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function FileField({
  label,
  file,
  onPick,
  onClear,
}: {
  label: string;
  file: File | null;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Button variant="outlined" size="small" startIcon={<UploadFileIcon />} onClick={onPick}>
          选择文件
        </Button>
        {file && (
          <>
            <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
              {file.name}（{(file.size / 1024).toFixed(1)} KB）
            </Typography>
            <Button size="small" onClick={onClear}>
              清除
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
}
