/**
 * Auth-flow tests for the axios wrapper (src/api/http.ts): Bearer
 * injection, single-flight refresh + retry on 401, no retry for auth
 * endpoints, and the refresh-failure logout path.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// --- axios mock -----------------------------------------------------------------
let refreshCalls = 0;
let refreshResult: unknown;
let refreshError: unknown;
let instanceCalls: Array<{ method: string; url: string; config?: unknown }> = [];

const responseHandlers: {
  onFulfilled?: (res: unknown) => unknown;
  onRejected?: (err: unknown) => unknown;
} = {};
const requestHandlers: Array<(config: unknown) => unknown> = [];

// axios instances are callable (http(original) retry); our mock must be too
const instance = Object.assign(
  (config?: unknown) => {
    instanceCalls.push({ method: "call", url: String((config as { url?: string })?.url ?? ""), config });
    return Promise.resolve({ data: {}, status: 200 });
  },
  {
    interceptors: {
      request: { use: (fn: (c: unknown) => unknown) => requestHandlers.push(fn) },
      response: {
        use: (ok: (r: unknown) => unknown, err: (e: unknown) => unknown) => {
          responseHandlers.onFulfilled = ok;
          responseHandlers.onRejected = err;
        },
      },
    },
    get: (url: string, config?: unknown) => {
      instanceCalls.push({ method: "get", url, config });
      return Promise.resolve({ data: {}, status: 200 });
    },
    post: (url: string, body?: unknown, config?: unknown) => {
      instanceCalls.push({ method: "post", url, config });
      return Promise.resolve({ data: {}, status: 200 });
    },
  },
);

mock.module("axios", () => ({
  default: {
    create: () => instance,
    post: async () => {
      refreshCalls += 1;
      if (refreshError) throw refreshError;
      return { data: refreshResult };
    },
    isAxiosError: (e: unknown) =>
      typeof e === "object" && e !== null && "isAxiosError" in e,
  },
}));

const {
  setAccessToken,
  setRefreshToken,
  getRefreshToken,
  setSessionEndHandler,
  ensureFreshAccessToken,
} = await import("./http");

// --- helpers ---------------------------------------------------------------------
function makeError(status: number, url: string): {
  isAxiosError: true;
  response: { status: number };
  config: { url: string; headers: Record<string, string>; _retried?: boolean };
} {
  return {
    isAxiosError: true,
    response: { status },
    config: { url, headers: {} },
  };
}

/** Builds a structurally-valid JWT with the given exp (seconds). */
function makeJwt(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `h.${payload}.s`;
}

function runRequestInterceptor(config: Record<string, unknown>): void {
  for (const fn of requestHandlers) fn(config);
}

function runResponseError(error: unknown): Promise<unknown> {
  return responseHandlers.onRejected!(error) as Promise<unknown>;
}

beforeEach(() => {
  refreshCalls = 0;
  refreshResult = { access_token: "new-access", refresh_token: "new-refresh" };
  refreshError = undefined;
  instanceCalls = [];
  setAccessToken(null);
  setRefreshToken(null);
  localStorage.clear();
});

describe("request interceptor", () => {
  test("injects the Bearer header when an access token is set", () => {
    setAccessToken("tok-123");
    const config: Record<string, unknown> = { headers: {} };
    runRequestInterceptor(config);
    expect((config.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-123",
    );
  });

  test("leaves the request untouched without a token", () => {
    const config: Record<string, unknown> = { headers: {} };
    runRequestInterceptor(config);
    expect((config.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("401 refresh + retry", () => {
  test("refreshes once and retries the original request", async () => {
    setAccessToken("stale-token");
    setRefreshToken("rt-1");
    const err = makeError(401, "/v1/devices");
    const result = await runResponseError(err);
    expect(refreshCalls).toBe(1);
    // retried via the instance
    expect(instanceCalls.length).toBeGreaterThan(0);
    // the retried request carries the new token
    const retried = instanceCalls[instanceCalls.length - 1]!;
    expect((retried.config as { headers?: Record<string, string> }).headers?.Authorization).toBe(
      "Bearer new-access",
    );
    // refresh token was rotated in storage
    expect(getRefreshToken()).toBe("new-refresh");
    expect(result).toBeDefined();
  });

  test("concurrent 401s share a single refresh (single flight)", async () => {
    setRefreshToken("rt-1");
    await Promise.all([
      runResponseError(makeError(401, "/v1/a")),
      runResponseError(makeError(401, "/v1/b")),
      runResponseError(makeError(401, "/v1/c")),
    ]);
    expect(refreshCalls).toBe(1);
  });

  test("auth endpoints are not retried (no refresh loop)", async () => {
    setRefreshToken("rt-1");
    await expect(runResponseError(makeError(401, "/v1/auth/login"))).rejects.toThrow();
    expect(refreshCalls).toBe(0);
    await expect(runResponseError(makeError(401, "/v1/auth/refresh"))).rejects.toThrow();
    expect(refreshCalls).toBe(0);
  });

  test("an already-retried request is not retried twice", async () => {
    setRefreshToken("rt-1");
    const err = makeError(401, "/v1/devices");
    err.config._retried = true;
    await expect(runResponseError(err)).rejects.toThrow();
    expect(refreshCalls).toBe(0);
  });

  test("a failed refresh wipes tokens, clears session data and bounces to /login", async () => {
    refreshError = new Error("refresh failed");
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    const onEnd = mock(() => {});
    setSessionEndHandler(onEnd);
    setAccessToken("stale");
    setRefreshToken("rt-1");
    await expect(runResponseError(makeError(401, "/v1/devices"))).rejects.toThrow();
    expect(getRefreshToken()).toBeNull();
    expect(onEnd).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/login");
    assign.mockRestore();
    setSessionEndHandler(null);
  });

  test("non-401 errors pass through untouched", async () => {
    setRefreshToken("rt-1");
    const err = makeError(500, "/v1/devices");
    await expect(runResponseError(err)).rejects.toBe(err);
    expect(refreshCalls).toBe(0);
  });
});

describe("token storage", () => {
  test("refresh token persists in localStorage and can be cleared", () => {
    setRefreshToken("abc");
    expect(getRefreshToken()).toBe("abc");
    expect(localStorage.getItem("soulcloud.refresh_token")).toBe("abc");
    setRefreshToken(null);
    expect(getRefreshToken()).toBeNull();
  });
});

describe("errorMessage", () => {
  test("extracts the server message from an axios error", async () => {
    const { errorMessage } = await import("./http");
    const err = {
      isAxiosError: true,
      response: { data: { message: "device_uid_taken" } },
    };
    expect(errorMessage(err)).toBe("device_uid_taken");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });
});

describe("ensureFreshAccessToken", () => {
  test("returns the current token without refreshing while it is fresh", async () => {
    const fresh = makeJwt(Math.floor(Date.now() / 1000) + 600);
    setAccessToken(fresh);
    setRefreshToken("rt-1");
    expect(await ensureFreshAccessToken()).toBe(fresh);
    expect(refreshCalls).toBe(0);
  });

  test("refreshes when the token is missing", async () => {
    setAccessToken(null);
    setRefreshToken("rt-1");
    expect(await ensureFreshAccessToken()).toBe("new-access");
    expect(refreshCalls).toBe(1);
    expect(getRefreshToken()).toBe("new-refresh");
  });

  test("refreshes when the token is already expired", async () => {
    setAccessToken(makeJwt(Math.floor(Date.now() / 1000) - 60));
    setRefreshToken("rt-1");
    expect(await ensureFreshAccessToken()).toBe("new-access");
    expect(refreshCalls).toBe(1);
  });

  test("refreshes proactively inside the 30s skew window", async () => {
    setAccessToken(makeJwt(Math.floor(Date.now() / 1000) + 20));
    setRefreshToken("rt-1");
    expect(await ensureFreshAccessToken()).toBe("new-access");
    expect(refreshCalls).toBe(1);
  });

  test("concurrent callers share one refresh", async () => {
    setAccessToken(null);
    setRefreshToken("rt-1");
    const [a, b, c] = await Promise.all([
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
    ]);
    expect(a).toBe("new-access");
    expect(b).toBe("new-access");
    expect(c).toBe("new-access");
    expect(refreshCalls).toBe(1);
  });

  test("a failed refresh returns null and clears the session without bouncing", async () => {
    refreshError = new Error("refresh failed");
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    const onEnd = mock(() => {});
    setSessionEndHandler(onEnd);
    setAccessToken("stale");
    setRefreshToken("rt-1");
    expect(await ensureFreshAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(onEnd).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    assign.mockRestore();
    setSessionEndHandler(null);
  });
});
