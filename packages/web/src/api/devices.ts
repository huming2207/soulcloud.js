import { http } from "./http";
import type {
  BindFirmwareResponse,
  CommandBatchDetail,
  CommandBatchRequest,
  CommandBatchResponse,
  CommandListResponse,
  CreateDeviceRequest,
  CreateDeviceResponse,
  DeviceDetail,
  DeviceListResponse,
  FirmwareState,
  IssuedCredentials,
  RevokeCredentialsResponse,
} from "./types";

// --- devices ----------------------------------------------------------------

export async function fetchDevices(
  projectId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<DeviceListResponse> {
  const res = await http.get<DeviceListResponse>(
    `/v1/projects/${projectId}/devices`,
    { params: { limit: params.limit ?? 100, offset: params.offset ?? 0 } },
  );
  return res.data;
}

export async function fetchDevice(deviceId: string): Promise<DeviceDetail> {
  const res = await http.get<DeviceDetail>(`/v1/devices/${deviceId}`);
  return res.data;
}

export async function createDevice(
  req: CreateDeviceRequest,
): Promise<CreateDeviceResponse> {
  const res = await http.post<CreateDeviceResponse>("/v1/devices", req);
  return res.data;
}

export async function issueCredentials(deviceId: string): Promise<IssuedCredentials> {
  const res = await http.post<IssuedCredentials>(
    `/v1/devices/${deviceId}/credentials`,
  );
  return res.data;
}

export async function revokeCredentials(deviceId: string): Promise<RevokeCredentialsResponse> {
  const res = await http.post<RevokeCredentialsResponse>(
    `/v1/devices/${deviceId}/credentials/revoke`,
  );
  return res.data;
}

// --- commands ---------------------------------------------------------------

export async function fetchDeviceCommands(
  deviceId: string,
  params: { limit?: number; cursor?: string } = {},
): Promise<CommandListResponse> {
  const res = await http.get<CommandListResponse>(
    `/v1/devices/${deviceId}/commands`,
    { params: { limit: params.limit ?? 50, ...(params.cursor ? { cursor: params.cursor } : {}) } },
  );
  return res.data;
}

export async function fetchCommandBatch(batchId: string): Promise<CommandBatchDetail> {
  const res = await http.get<CommandBatchDetail>(`/v1/command-batches/${batchId}`);
  return res.data;
}

export async function postCommandBatch(req: CommandBatchRequest): Promise<CommandBatchResponse> {
  const res = await http.post<CommandBatchResponse>("/v1/command-batches", req);
  return res.data;
}

// --- firmware state ---------------------------------------------------------

export async function fetchDeviceFirmwareState(deviceId: string): Promise<FirmwareState> {
  const res = await http.get<FirmwareState>(`/v1/devices/${deviceId}/firmware-state`);
  return res.data;
}

export async function bindFirmwareState(
  deviceId: string,
  artifactId: string,
): Promise<BindFirmwareResponse> {
  const res = await http.post<BindFirmwareResponse>(
    `/v1/devices/${deviceId}/firmware-state`,
    { artifact_id: artifactId },
  );
  return res.data;
}
