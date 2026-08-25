import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { errorMessage } from "../api/http";
import { fetchPluginUiSession, postPluginUiBootstrap } from "../api/plugins";

/**
 * Main-origin handoff page for plugin UI. It does not render plugin code; it
 * only exchanges a Human API grant for the dedicated plugin-origin session.
 */
export function PluginUiLaunchPage() {
  const { installationId, routeId } = useParams<{ installationId: string; routeId: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!installationId || !routeId) {
      setError("Plugin UI route is incomplete");
      return () => { cancelled = true; };
    }
    void fetchPluginUiSession(installationId, routeId)
      .then((session) => {
        if (!cancelled) postPluginUiBootstrap(session);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => { cancelled = true; };
  }, [installationId, routeId]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, py: 8 }}>
      {error ? (
        <Alert severity="error" role="alert">{error}</Alert>
      ) : (
        <>
          <CircularProgress aria-label="Opening plugin interface" />
          <Typography color="text.secondary">Opening plugin interface…</Typography>
        </>
      )}
    </Box>
  );
}
