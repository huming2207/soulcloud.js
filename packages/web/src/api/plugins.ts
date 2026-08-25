import { http } from "./http";

export interface PluginUiSession {
  bootstrap_url: string;
  bootstrap_token: string;
  path: string;
  expires_in: number;
}

/**
 * Requests a short-lived, one-time UI bootstrap grant from Human API.
 * The grant is intentionally kept in memory and is never put in a URL or
 * persistent browser storage.
 */
export async function fetchPluginUiSession(
  installationId: string,
  routeId: string,
  locale?: string,
): Promise<PluginUiSession> {
  const response = await http.get<PluginUiSession>(
    `/v1/plugin-installations/${encodeURIComponent(installationId)}/ui-session/${encodeURIComponent(routeId)}`,
    { params: locale ? { locale } : undefined },
  );
  return response.data;
}

/**
 * Transfers a one-time grant to the dedicated Plugin Manager origin using a
 * form POST. Browser navigation avoids CORS and keeps the grant out of URL
 * history, referrers and the plugin page's query string.
 */
export function postPluginUiBootstrap(session: PluginUiSession): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = session.bootstrap_url;
  form.target = "_self";
  form.style.display = "none";
  const token = document.createElement("input");
  token.type = "hidden";
  token.name = "bootstrap_token";
  token.value = session.bootstrap_token;
  form.appendChild(token);
  document.body.appendChild(form);
  form.submit();
}
