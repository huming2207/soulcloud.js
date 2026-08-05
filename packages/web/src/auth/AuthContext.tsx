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
import {
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "authed" | "anon">("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

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
        setStatus("anon");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    setUser(null);
    setStatus("anon");
  }, []);

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
