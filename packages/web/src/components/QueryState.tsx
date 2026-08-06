import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import { errorMessage } from "../api/http";
import { useI18n } from "../i18n/I18nContext";

/** Skeleton placeholder for list/table bodies while a query loads. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Stack spacing={1} sx={{ py: 1 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="rounded" height={40} />
      ))}
    </Stack>
  );
}

/** Card-sized skeleton for detail pages. */
export function CardSkeleton() {
  return (
    <Stack spacing={1}>
      <Skeleton variant="rounded" height={56} />
      <Skeleton variant="rounded" height={120} />
    </Stack>
  );
}

/** Inline query error with an optional retry action. */
export function QueryError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Alert
      severity="error"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            {t("query.retry")}
          </Button>
        ) : undefined
      }
    >
      {errorMessage(error)}
    </Alert>
  );
}
