import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ProjectSummary } from "../api/types";
import { useMeQuery } from "../auth/ProtectedRoute";

const PROJECT_KEY = "soulcloud.project_id";

interface ProjectContextValue {
  /** All projects the current user can access (from /v1/me). */
  projects: ProjectSummary[];
  /** The active project id (persisted per browser). */
  projectId: string | null;
  /** The active project object, or null while loading/unknown. */
  project: ProjectSummary | null;
  setProjectId: (id: string) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMeQuery();
  const [projectId, setProjectIdState] = useState<string | null>(() =>
    localStorage.getItem(PROJECT_KEY),
  );

  const projects = me?.projects ?? [];

  // Keep the selection valid: fall back to the first project when the
  // stored id no longer exists (e.g. a new user's first load).
  useEffect(() => {
    if (projects.length === 0) return;
    if (projectId && projects.some((p) => p.project_id === projectId)) return;
    const first = projects[0];
    if (first) {
      setProjectIdState(first.project_id);
      localStorage.setItem(PROJECT_KEY, first.project_id);
    }
  }, [projects, projectId]);

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    localStorage.setItem(PROJECT_KEY, id);
  }, []);

  const project = useMemo(
    () => projects.find((p) => p.project_id === projectId) ?? null,
    [projects, projectId],
  );

  const value = useMemo(
    () => ({ projects, projectId, project, setProjectId }),
    [projects, projectId, project, setProjectId],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
}
