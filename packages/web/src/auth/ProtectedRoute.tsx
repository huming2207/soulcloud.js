import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { useQuery } from "@tanstack/react-query";
import { fetchMe } from "../api/auth";
import { useAuth } from "./AuthContext";

/**
 * Guards authenticated routes: shows a loader while the session is being
 * restored and redirects anonymous users to /login.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }
  if (status === "anon") {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/** /v1/me query, shared by the layout and the project selector. */
export function useMeQuery() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    enabled: status === "authed",
    staleTime: 60_000,
  });
}
