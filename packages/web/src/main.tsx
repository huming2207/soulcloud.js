import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import CssBaseline from "@mui/material/CssBaseline";
import { AuthProvider } from "./auth/AuthContext";
import { ProjectProvider } from "./layout/ProjectContext";
import { router } from "./router";
import { useI18n, I18nProvider } from "./i18n/I18nContext";
import { setSessionEndHandler } from "./api/http";

export function App() {
  return (
    <I18nProvider>
      <ThemedApp>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ProjectProvider>
              <RouterProvider router={router} />
            </ProjectProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemedApp>
    </I18nProvider>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// forced logout (refresh failure mid-session) must drop cached data too
setSessionEndHandler(() => queryClient.clear());

/** Applies the locale-aware MUI theme (component texts follow the locale). */
function ThemedApp({ children }: { children: ReactNode }) {
  const { theme } = useI18n();
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InitColorSchemeScript />
    <App />
  </StrictMode>,
);
