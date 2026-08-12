import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as authApi from "../api/auth";
import { useQueryClient } from "@tanstack/react-query";
import {
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  subscribeSessionEnd,
} from "../api/http";

interface AuthUser {
  userId: string;
  username: string;
}

interface AuthContextValue {
  /** loading = restoring a session from the refresh token. */
  status: "loading" | "authed" | "anon";
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Clears per-account browser state beyond the TanStack cache: the
 * per-device command history (soulcloud.cmdhistory.<deviceId>) and the
 * remembered project selection must not leak into the next account on
 * this browser.
 */
function clearPerAccountLocalStorage(): void {
  try {
    const prefix = "soulcloud.cmdhistory.";
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) localStorage.removeItem(key);
    }
    localStorage.removeItem("soulcloud.project_id");
  } catch {
    // storage unavailable (privacy mode etc.): nothing to clear
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "authed" | "anon">("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const queryClient = useQueryClient();

  // A refresh can fail in a request outside this provider (for example a
  // background query or WebSocket reconnect). Reflect that forced logout in
  // React state immediately instead of waiting for a navigation or reload.
  useEffect(() => {
    return subscribeSessionEnd(() => {
      queryClient.clear();
      clearPerAccountLocalStorage();
      setUser(null);
      setStatus("anon");
    });
  }, [queryClient]);

  // Session restore: with only a refresh token stored, fetchMe() gets a 401
  // and the http interceptor transparently refreshes + retries it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getRefreshToken()) {
        setStatus("anon");
        return;
      }
      try {
        const me = await authApi.fetchMe();
        if (cancelled) return;
        setUser({ userId: me.user_id, username: me.username });
        setStatus("authed");
      } catch {
        if (cancelled) return;
        setAccessToken(null);
        setRefreshToken(null);
        // the stored session is gone; drop cached data so it cannot leak
        // into a later account on this browser
        queryClient.clear();
        clearPerAccountLocalStorage();
        setStatus("anon");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    setAccessToken(res.access_token);
    setRefreshToken(res.refresh_token);
    setUser({ userId: res.user_id, username });
    setStatus("authed");
  }, []);

  const register = useCallback(
    async (username: string, password: string, email: string) => {
      const res = await authApi.register(username, password, email);
      setAccessToken(res.access_token);
      setRefreshToken(res.refresh_token);
      setUser({ userId: res.user_id, username });
      setStatus("authed");
    },
    [],
  );

  const logout = useCallback(async () => {
    await authApi.logout();
    setAccessToken(null);
    setRefreshToken(null);
    // wipe all cached queries (devices/logs/rollouts belong to the
    // previous account; a later login on this browser must start clean)
    queryClient.clear();
    clearPerAccountLocalStorage();
    setUser(null);
    setStatus("anon");
  }, [queryClient]);

  const value = useMemo(
    () => ({ status, user, login, register, logout }),
    [status, user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
