/**
 * Axios instance with the Soulcloud auth flow:
 *   - Bearer access token injected on every request (kept in memory only)
 *   - refresh token persisted in localStorage (rotated on every use)
 *   - on 401 (except auth endpoints): single-flight refresh + retry once
 *   - on refresh failure: wipe tokens and bounce to /login
 *
 * The access token intentionally never touches localStorage: it is short
 * lived (15 min) and recovered from the refresh token after a page reload.
 */

import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { TokenPair } from "./types";

const REFRESH_TOKEN_KEY = "soulcloud.refresh_token";

let accessToken: string | null = null;
let refreshInFlight: Promise<string> | null = null;

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string | null): void {
  if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
  else localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Returns the current in-memory access token, or null when signed out.
 * Needed where headers cannot be set (e.g. the WebSocket log stream
 * carries the token in its subprotocol list).
 */
export function getAccessToken(): string | null {
  return accessToken;
}

let sessionEndHandler: (() => void) | null = null;
const sessionEndListeners = new Set<() => void>();

/** How early (ms) before JWT expiry a token is treated as stale. */
const ACCESS_TOKEN_EXPIRE_SKEW_MS = 30_000;

/**
 * Registers a callback invoked when the session ends (failed refresh,
 * i.e. forced logout). The app wires it to queryClient.clear() so one
 * account's cached data can never leak into the next session.
 */
export function setSessionEndHandler(fn: (() => void) | null): void {
  sessionEndHandler = fn;
}

/**
 * Subscribes to forced-session-end events. This is separate from the legacy
 * application handler so stateful providers can immediately reflect a
 * failed refresh without owning the HTTP interceptor.
 */
export function subscribeSessionEnd(fn: () => void): () => void {
  sessionEndListeners.add(fn);
  return () => sessionEndListeners.delete(fn);
}

/** Clears the session state (forced logout); used by the 401 interceptor
 * and the WS reconnect path when the refresh token is rejected. */
function endSession(): void {
  accessToken = null;
  setRefreshToken(null);
  sessionEndHandler?.();
  for (const listener of sessionEndListeners) {
    try {
      listener();
    } catch {
      // A view listener must not prevent token clearing or other listeners.
    }
  }
}

function isAccessTokenExpired(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    // JWT payloads are base64url; atob needs the standard alphabet
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    return (
      typeof json.exp !== "number" ||
      json.exp * 1000 - ACCESS_TOKEN_EXPIRE_SKEW_MS <= Date.now()
    );
  } catch {
    return true; // unparsable: treat as expired and refresh
  }
}

/**
 * Returns a fresh access token for flows outside the axios interceptor
 * (WebSocket reconnects). Refreshes single-flight when the in-memory token
 * is missing or already expired; returns null when the refresh fails (the
 * session ended - the caller should stop retrying).
 */
export async function ensureFreshAccessToken(): Promise<string | null> {
  if (accessToken && !isAccessTokenExpired(accessToken)) return accessToken;
  try {
    return await refreshTokens();
  } catch {
    endSession();
    return null;
  }
}

/**
 * Performs one refresh round-trip. Must run under the cross-tab lock when
 * available: rotation revokes the previous token server-side, so two tabs
 * refreshing concurrently would trip reuse detection (reuse_detected
 * revokes the WHOLE session family) and force a logout in both tabs.
 */
async function doRefreshRoundTrip(): Promise<string> {
  const rt = getRefreshToken();
  if (!rt) throw new Error("no refresh token stored");
  // bare axios: this call must not go through the 401-retry interceptor
  const res = await axios.post<TokenPair>("/v1/auth/refresh", {
    refresh_token: rt,
  });
  setRefreshToken(res.data.refresh_token);
  accessToken = res.data.access_token;
  return res.data.access_token;
}

/** Refreshes the token pair once; concurrent callers share the promise.
 *  Web Locks extends the single-flight across tabs of the same origin:
 *  tab B re-reads the rotated token from shared localStorage after tab A
 *  finishes, so it never replays an already-revoked token. */
function refreshTokens(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      if (typeof navigator !== "undefined" && navigator.locks?.request) {
        return navigator.locks.request("soulcloud-refresh", async () => {
          return doRefreshRoundTrip();
        });
      }
      return doRefreshRoundTrip();
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

export const http = axios.create({ baseURL: "/" });

http.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

http.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as RetryableConfig | undefined;
    const url = original?.url ?? "";
    // credential endpoints handle their own 401s; everything else may
    // legitimately hit an expired access token and must refresh+retry
    const isAuthCall = /^\/v1\/auth\/(login|register|refresh|logout)$/.test(url);
    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      try {
        const token = await refreshTokens();
        original.headers.Authorization = `Bearer ${token}`;
        return http(original);
      } catch {
        endSession();
        if (window.location.pathname !== "/login") {
          window.location.assign("/login");
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  },
);

/** Extracts the human-readable message from an axios error, if any. */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
