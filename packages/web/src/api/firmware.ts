import { http } from "./http";
import type {
  ArtifactListResponse,
  ArtifactUploadResponse,
  DeployResponse,
  OtaJobDetail,
  ReleaseDetail,
  ReleaseListResponse,
  ReleaseUploadResponse,
  RolloutCreateRequest,
  RolloutCreateResponse,
  RolloutDetail,
  RolloutListResponse,
} from "./types";

// --- firmware artifacts (ELF, log dictionaries) ------------------------------

export async function fetchArtifacts(
  projectId: string,
  limit = 100,
): Promise<ArtifactListResponse> {
  const res = await http.get<ArtifactListResponse>("/v1/firmware-artifacts", {
    params: { project_id: projectId, limit },
  });
  return res.data;
}

export async function uploadArtifact(
  projectId: string,
  file: File,
  version?: string,
): Promise<ArtifactUploadResponse> {
  const form = new FormData();
  form.append("project_id", projectId);
  if (version) form.append("version", version);
  form.append("file", file);
  const res = await http.post<ArtifactUploadResponse>("/v1/firmware-artifacts", form);
  return res.data;
}

// --- firmware releases -------------------------------------------------------

export async function fetchReleases(
  projectId: string,
  params: { limit?: number; cursor?: string } = {},
): Promise<ReleaseListResponse> {
  const res = await http.get<ReleaseListResponse>("/v1/firmware-releases", {
    params: {
      project_id: projectId,
      limit: params.limit ?? 100,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
  });
  return res.data;
}

export async function fetchRelease(releaseId: string): Promise<ReleaseDetail> {
  const res = await http.get<ReleaseDetail>(`/v1/firmware-releases/${releaseId}`);
  return res.data;
}

export async function uploadRelease(
  projectId: string,
  files: { bin: File; elf?: File },
  version?: string,
): Promise<ReleaseUploadResponse> {
  const form = new FormData();
  form.append("project_id", projectId);
  if (version) form.append("version", version);
  form.append("bin", files.bin);
  if (files.elf) form.append("elf", files.elf);
  const res = await http.post<ReleaseUploadResponse>("/v1/firmware-releases", form);
  return res.data;
}

/** Downloads the release bin with the Bearer token (blob -> object URL). */
export async function downloadRelease(releaseId: string): Promise<Blob> {
  const res = await http.get<Blob>(`/v1/firmware-releases/${releaseId}/bin`, {
    responseType: "blob",
  });
  return res.data;
}

export async function deployRelease(
  releaseId: string,
  deviceIds: string[],
): Promise<DeployResponse> {
  const res = await http.post<DeployResponse>(
    `/v1/firmware-releases/${releaseId}/deploy`,
    { device_ids: deviceIds },
  );
  return res.data;
}

// --- OTA jobs -----------------------------------------------------------------

export async function fetchOtaJob(jobId: string): Promise<OtaJobDetail> {
  const res = await http.get<OtaJobDetail>(`/v1/ota-jobs/${jobId}`);
  return res.data;
}

// --- rollouts -----------------------------------------------------------------

export async function fetchRollouts(
  projectId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<RolloutListResponse> {
  const res = await http.get<RolloutListResponse>("/v1/ota-rollouts", {
    params: {
      project_id: projectId,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    },
  });
  return res.data;
}

export async function fetchRollout(rolloutId: string): Promise<RolloutDetail> {
  const res = await http.get<RolloutDetail>(`/v1/ota-rollouts/${rolloutId}`);
  return res.data;
}

export async function createRollout(
  releaseId: string,
  req: RolloutCreateRequest,
): Promise<RolloutCreateResponse> {
  const res = await http.post<RolloutCreateResponse>(
    `/v1/firmware-releases/${releaseId}/rollouts`,
    req,
  );
  return res.data;
}

export async function pauseRollout(rolloutId: string): Promise<void> {
  await http.post(`/v1/ota-rollouts/${rolloutId}/pause`);
}

export async function resumeRollout(rolloutId: string): Promise<void> {
  await http.post(`/v1/ota-rollouts/${rolloutId}/resume`);
}

export async function abortRollout(rolloutId: string): Promise<void> {
  await http.post(`/v1/ota-rollouts/${rolloutId}/abort`);
}

export async function rollbackRollout(
  rolloutId: string,
): Promise<{ rollback_job_id: string | null; target_devices: number }> {
  const res = await http.post<{
    rollback_job_id: string | null;
    target_devices: number;
  }>(`/v1/ota-rollouts/${rolloutId}/rollback`);
  return res.data;
}

/** Trigger a browser download of a release bin. */
export async function triggerReleaseDownload(releaseId: string, filename: string): Promise<void> {
  const blob = await downloadRelease(releaseId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
