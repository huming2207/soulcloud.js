import { http, getRefreshToken } from "./http";
import type { AuthResponse, MeResponse } from "./types";

export async function login(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const res = await http.post<AuthResponse>("/v1/auth/login", {
    username,
    password,
  });
  return res.data;
}

export async function register(
  username: string,
  password: string,
  email: string,
): Promise<AuthResponse> {
  const res = await http.post<AuthResponse>("/v1/auth/register", {
    username,
    password,
    email,
  });
  return res.data;
}

/** Revokes the stored refresh token server-side (best effort). */
export async function logout(): Promise<void> {
  const rt = getRefreshToken();
  if (!rt) return;
  try {
    await http.post("/v1/auth/logout", { refresh_token: rt });
  } catch {
    // the token is wiped locally regardless; nothing to recover
  }
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await http.get<MeResponse>("/v1/me");
  return res.data;
}
