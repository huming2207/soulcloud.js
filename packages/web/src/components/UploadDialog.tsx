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
import { useI18n } from "../i18n/I18nContext";

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
  const { t } = useI18n();
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
          setError(t("upload.needElf"));
          return;
        }
        const res = await uploadArtifact(
          projectId,
          elfFile,
          version.trim() || undefined,
        );
        setResult(
          t("upload.artifactDone", { tags: res.tag_count, formats: res.format_count, backfilled: res.backfilled_events }),
        );
      } else {
        if (!binFile) {
          setError(t("upload.needBin"));
          return;
        }
        const res = await uploadRelease(
          projectId,
          { bin: binFile, elf: elfFile ?? undefined },
          version.trim() || undefined,
        );
        setResult(
          t("upload.releaseDone", { linked: res.artifact_id ? t("upload.linkedSuffix") : "", size: res.bin_size }),
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
        <DialogTitle>{isRelease ? t("upload.releaseTitle") : t("upload.artifactTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {isRelease
              ? t("upload.releaseBody")
              : t("upload.artifactBody")}
          </DialogContentText>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            {result && <Alert severity="success">{result}</Alert>}
            <TextField
              label={t("upload.version")}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              fullWidth
            />
            {isRelease && (
              <FileField
                label={t("upload.bin")}
                file={binFile}
                onPick={() => binInput.current?.click()}
                onClear={() => setBinFile(null)}
              />
            )}
            <FileField
              label={isRelease ? t("upload.elf") : t("upload.elfRequired")}
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
          <Button onClick={handleClose}>{t("upload.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting ? t("upload.uploading") : t("upload.submit")}
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
  const { t } = useI18n();
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Button variant="outlined" size="small" startIcon={<UploadFileIcon />} onClick={onPick}>
          {t("upload.pick")}
        </Button>
        {file && (
          <>
            <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
              {file.name}（{(file.size / 1024).toFixed(1)} KB）
            </Typography>
            <Button size="small" onClick={onClear}>
              {t("upload.clear")}
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
}
