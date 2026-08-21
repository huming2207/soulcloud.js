import { http } from "./http";

// --- plugin view (stage 3 declarative UI) -----------------------------------

export interface EntityDescriptorView {
  key: string;
  value_type: "number" | "boolean" | "string" | "enum" | "binary";
  access: "read" | "write" | "read_write";
  category: "primary" | "diagnostic" | "configuration" | "measurement" | "counter";
  unit: string | null;
  enum_values: string[] | null;
  stale_after_seconds: number | null;
  history: "none" | "changes" | "sampled" | "all";
  display_name: string | null;
}

export interface EntityStateView {
  entityKey: string;
  value: unknown;
  quality: string;
  sourceTimestamp: string | null;
  ingestedAt: string;
  sequence: string | null;
  alarmLevel: string | null;
  alarmCode: string | null;
}

export interface PluginView {
  binding: {
    installation_id: string | null;
    plugin_id: string;
    plugin_version: string | null;
    profile_id: string;
    profile_version: number;
  };
  entities: Array<{ descriptor: EntityDescriptorView; state: EntityStateView | null }>;
}

export interface ActionView {
  id: string;
  input_schema: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean";
      required?: boolean;
      enum?: string[];
      min?: number;
      max?: number;
      title?: string;
      description?: string;
      default?: string | number | boolean;
    }
  >;
  wire_command: string;
  schema_version: number;
}

export interface InvokeActionResponse {
  batch_id: string;
  device_count: number;
  wire_command: string;
  schema_version: number;
}

export async function fetchPluginView(deviceId: string): Promise<PluginView> {
  const res = await http.get<PluginView>(`/v1/devices/${deviceId}/plugin-view`);
  return res.data;
}

export async function fetchDeviceActions(deviceId: string): Promise<{ actions: ActionView[] }> {
  const res = await http.get<{ actions: ActionView[] }>(`/v1/devices/${deviceId}/actions`);
  return res.data;
}

export async function invokeDeviceAction(
  deviceId: string,
  actionId: string,
  input: Record<string, unknown>,
): Promise<InvokeActionResponse> {
  const res = await http.post<InvokeActionResponse>(
    `/v1/devices/${deviceId}/actions/${actionId}`,
    { input },
  );
  return res.data;
}
