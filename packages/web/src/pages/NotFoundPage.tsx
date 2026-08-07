import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nContext";

/** Catch-all route: unknown paths get a real 404 instead of a blank page. */
export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <Card sx={{ maxWidth: 640, mx: "auto", mt: 6 }}>
      <CardContent sx={{ textAlign: "center", py: 6 }}>
        <Typography variant="h4" gutterBottom>
          404
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          {t("notFound.title")}
        </Typography>
        <Button component={Link} to="/" variant="contained">
          {t("notFound.home")}
        </Button>
      </CardContent>
    </Card>
  );
}
