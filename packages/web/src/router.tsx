import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { AppLayout } from "./layout/AppLayout";
import { ProtectedRoute } from "./auth/ProtectedRoute";

// route-level code splitting: MUI + Data Grid stay out of the login chunk
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const RegisterPage = lazy(() =>
  import("./pages/RegisterPage").then((m) => ({ default: m.RegisterPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const DevicesPage = lazy(() =>
  import("./pages/DevicesPage").then((m) => ({ default: m.DevicesPage })),
);
const DeviceDetailPage = lazy(() =>
  import("./pages/DeviceDetailPage").then((m) => ({ default: m.DeviceDetailPage })),
);
const LogsPage = lazy(() =>
  import("./pages/LogsPage").then((m) => ({ default: m.LogsPage })),
);
const FirmwarePage = lazy(() =>
  import("./pages/FirmwarePage").then((m) => ({ default: m.FirmwarePage })),
);
const RolloutsPage = lazy(() =>
  import("./pages/RolloutsPage").then((m) => ({ default: m.RolloutsPage })),
);
const RolloutDetailPage = lazy(() =>
  import("./pages/RolloutDetailPage").then((m) => ({ default: m.RolloutDetailPage })),
);
const OtaJobPage = lazy(() =>
  import("./pages/OtaJobPage").then((m) => ({ default: m.OtaJobPage })),
);
const PluginUiLaunchPage = lazy(() =>
  import("./pages/PluginUiLaunchPage").then((m) => ({ default: m.PluginUiLaunchPage })),
);
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);

function PageLoader() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
      <CircularProgress />
    </Box>
  );
}

function withLoader(element: React.ReactNode) {
  return <Suspense fallback={<PageLoader />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  { path: "/login", element: withLoader(<LoginPage />) },
  { path: "/register", element: withLoader(<RegisterPage />) },
  {
    element: (
      <ProtectedRoute>
        <AppLayout />
      </ProtectedRoute>
    ),
    children: [
      { path: "/", element: withLoader(<DashboardPage />) },
      { path: "/devices", element: withLoader(<DevicesPage />) },
      { path: "/devices/:deviceId", element: withLoader(<DeviceDetailPage />) },
      { path: "/logs", element: withLoader(<LogsPage />) },
      { path: "/firmware", element: withLoader(<FirmwarePage />) },
      { path: "/rollouts", element: withLoader(<RolloutsPage />) },
      { path: "/rollouts/:rolloutId", element: withLoader(<RolloutDetailPage />) },
      { path: "/ota-jobs/:jobId", element: withLoader(<OtaJobPage />) },
      { path: "/plugin-ui/:installationId/:routeId", element: withLoader(<PluginUiLaunchPage />) },
    ],
  },
  { path: "*", element: withLoader(<NotFoundPage />) },
]);
