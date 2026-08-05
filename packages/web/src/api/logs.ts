import { http } from "./http";
import type { LogListResponse } from "./types";

export async function fetchDeviceLogs(
  deviceId: string,
  params: { limit?: number; cursor?: string; includeRaw?: boolean } = {},
): Promise<LogListResponse> {
  const res = await http.get<LogListResponse>(`/v1/devices/${deviceId}/logs`, {
    params: {
      limit: params.limit ?? 100,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.includeRaw ? { include_raw: 1 } : {}),
    },
  });
  return res.data;
}
