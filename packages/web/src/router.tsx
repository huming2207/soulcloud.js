import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout/AppLayout";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DevicesPage } from "./pages/DevicesPage";
import { DeviceDetailPage } from "./pages/DeviceDetailPage";
import { LogsPage } from "./pages/LogsPage";
import { FirmwarePage } from "./pages/FirmwarePage";
import { RolloutsPage } from "./pages/RolloutsPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    element: (
      <ProtectedRoute>
        <AppLayout />
      </ProtectedRoute>
    ),
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/devices", element: <DevicesPage /> },
      { path: "/devices/:deviceId", element: <DeviceDetailPage /> },
      { path: "/logs", element: <LogsPage /> },
      { path: "/firmware", element: <FirmwarePage /> },
      { path: "/rollouts", element: <RolloutsPage /> },
    ],
  },
]);
