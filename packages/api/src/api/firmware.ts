/**
 * OTA firmware release routes: upload (bin required, ELF optional),
 * listing/detail, and single-use temporary download URLs.
 *
 * Error mapping follows the project conventions: 400 invalid_request,
 * 403 forbidden, 404 not_found, 413 payload_too_large, 422 invalid_elf,
 * 500 internal. Every parameter is Zod-validated and all handlers are
 * wrapped with `handleApiError`.
 */

import { Elysia } from "elysia";
import {
  ArtifactImportError,
  MAX_FIRMWARE_BYTES,
  ReleaseError,
  consumeDownloadToken,
  createDownloadToken,
  createFirmwareRelease,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import {
  LimitParam,
  UuidParam,
  authenticateRequest,
  handleApiError,
  userCanAccessProject,
} from "./validate";

const DOWNLOAD_URL_TTL_SECONDS = 180;

/** Multipart form data as returned by Bun/undici (not DOM FormData). */
type MultipartFormData = Awaited<ReturnType<Request["formData"]>>;

/** Parses multipart bodies with a hard cap (declared length + streamed). */
async function readMultipart(
  request: Request,
  set: { status?: number | string },
  maxBytes: number,
): Promise<MultipartFormData | null> {
  const declared = request.headers.get("content-length");
  const limit = maxBytes + 64 * 1024;
  if (declared && Number(declared) > limit) {
    set.status = 413;
    return null;
  }
  let body: Uint8Array;
  if (declared === null && request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          set.status = 413;
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    body = Buffer.concat(chunks);
  } else {
    body = new Uint8Array(await request.arrayBuffer());
  }
  return await new Response(body, {
    headers: {
      "content-type": request.headers.get("content-type") ?? "multipart/form-data",
    },
  })
    .formData()
    .catch(() => null);
}

function isFile(value: unknown): value is File {
  return typeof value === "object" && value !== null && "arrayBuffer" in value;
}

export function createFirmwareRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    // --- upload ------------------------------------------------------------

    .post("/firmware-releases", async ({ request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const form = await readMultipart(request, set, 2 * MAX_FIRMWARE_BYTES);
        if (!form) {
          if (set.status === 413) {
            return {
              error: "payload_too_large",
              message: `firmware files exceed ${MAX_FIRMWARE_BYTES} bytes each`,
            };
          }
          set.status = 400;
          return { error: "invalid_request", message: "expected multipart/form-data" };
        }
        const projectIdRaw = String(form.get("project_id") ?? "");
        const projectId = UuidParam.safeParse(projectIdRaw);
        if (!projectId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "project_id must be a UUID" };
        }
        const version = form.get("version");
        const bin = form.get("bin");
        const elf = form.get("elf");

        if (!isFile(bin)) {
          set.status = 422;
          return { error: "invalid_request", message: "bin file is required" };
        }
        if (elf !== null && !isFile(elf)) {
          set.status = 400;
          return { error: "invalid_request", message: "elf must be a file" };
        }

        const project = await prisma.project.findUnique({
          where: { id: projectId.data },
          select: { id: true },
        });
        if (!project) {
          set.status = 404;
          return { error: "project_not_found", message: "project does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, projectId.data))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }

        const binBytes = new Uint8Array(await bin.arrayBuffer());
        const elfBytes = elf ? new Uint8Array(await elf.arrayBuffer()) : undefined;
        try {
          const created = await createFirmwareRelease(prisma, {
            projectId: projectId.data,
            bin: binBytes,
            elf: elfBytes,
            version: typeof version === "string" && version ? version : undefined,
          });
          set.status = created.existed ? 200 : 201;
          return {
            release_id: created.releaseId,
            bin_hash: created.binHash,
            bin_size: created.binSize,
            artifact_id: created.artifactId,
            version: created.version,
          };
        } catch (error) {
          if (error instanceof ReleaseError) {
            if (error.kind === "too_large") {
              set.status = 413;
              return {
                error: "payload_too_large",
                message: error.message,
              };
            }
            set.status = 422;
            return { error: "invalid_request", message: error.message };
          }
          if (error instanceof ArtifactImportError) {
            if (error.kind === "too_large") {
              set.status = 413;
              return { error: "payload_too_large", message: error.message };
            }
            set.status = 422;
            return { error: "invalid_elf", message: error.message };
          }
          throw error;
        }
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- list --------------------------------------------------------------

    .get("/firmware-releases", async ({ request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const url = new URL(request.url);
        const projectId = UuidParam.safeParse(url.searchParams.get("project_id") ?? "");
        if (!projectId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "project_id must be a UUID" };
        }
        const limit = LimitParam.safeParse(url.searchParams.get("limit") ?? "100");
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: "limit must be an integer 1..500" };
        }
        const cursorRaw = url.searchParams.get("cursor");
        let cursor: { createdAt: Date; id: string } | null = null;
        if (cursorRaw) {
          // composite keyset cursor: createdAt ISO timestamp | release id
          const parts = cursorRaw.split("|");
          if (parts.length !== 2 || !UuidParam.safeParse(parts[1]).success) {
            set.status = 400;
            return { error: "invalid_request", message: "cursor must be <createdAt>|<releaseId>" };
          }
          const createdAt = new Date(parts[0]!);
          if (Number.isNaN(createdAt.getTime())) {
            set.status = 400;
            return { error: "invalid_request", message: "cursor must be <createdAt>|<releaseId>" };
          }
          cursor = { createdAt, id: parts[1]! };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, projectId.data))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        const rows = await prisma.firmwareRelease.findMany({
          where: {
            projectId: projectId.data,
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit.data + 1,
          select: {
            id: true,
            binHash: true,
            binSize: true,
            version: true,
            artifactId: true,
            createdAt: true,
          },
        });
        const hasMore = rows.length > limit.data;
        const items = hasMore ? rows.slice(0, limit.data) : rows;
        const last = items[items.length - 1]!;
        return {
          items: items.map((r) => ({
            release_id: r.id,
            bin_hash: r.binHash,
            bin_size: r.binSize,
            version: r.version,
            artifact_id: r.artifactId,
            created_at: r.createdAt,
          })),
          next_cursor: hasMore
            ? `${last.createdAt.toISOString()}|${last.id}`
            : null,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- detail ------------------------------------------------------------

    .get("/firmware-releases/:id", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "release does not exist" };
        }
        const release = await prisma.firmwareRelease.findUnique({
          where: { id: id.data },
          select: {
            id: true,
            projectId: true,
            binHash: true,
            binSize: true,
            version: true,
            createdAt: true,
            artifact: {
              select: {
                id: true,
                buildId: true,
                _count: { select: { logStrings: true } },
              },
            },
          },
        });
        if (!release) {
          set.status = 404;
          return { error: "not_found", message: "release does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, release.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        return {
          release_id: release.id,
          bin_hash: release.binHash,
          bin_size: release.binSize,
          version: release.version,
          created_at: release.createdAt,
          artifact: release.artifact
            ? {
                artifact_id: release.artifact.id,
                build_id: release.artifact.buildId,
                dictionary_entries: release.artifact._count.logStrings,
              }
            : null,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- single-use download URL -------------------------------------------

    .post("/firmware-releases/:id/download-token", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "release does not exist" };
        }
        const release = await prisma.firmwareRelease.findUnique({
          where: { id: id.data },
          select: { id: true, projectId: true },
        });
        if (!release) {
          set.status = 404;
          return { error: "not_found", message: "release does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, release.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        const { token, expiresAt } = await createDownloadToken(prisma, release.id);
        return {
          token,
          expires_at: expiresAt,
          url: `/v1/firmware-releases/${release.id}/bin?token=${token}`,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- download (no Bearer; the token IS the credential) -----------------

    .get("/firmware-releases/:id/bin", async ({ request, params, set }) => {
      try {
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 403;
          return { error: "invalid_download_token", message: "invalid download token" };
        }
        const url = new URL(request.url);
        const token = url.searchParams.get("token") ?? "";
        if (token.length === 0) {
          set.status = 403;
          return { error: "invalid_download_token", message: "invalid download token" };
        }
        // atomic single-use consumption (also guards release mismatch)
        const consumed = await consumeDownloadToken(prisma, id.data, token);
        if (!consumed) {
          set.status = 403;
          return { error: "invalid_download_token", message: "invalid download token" };
        }
        const release = await prisma.firmwareRelease.findUnique({
          where: { id: id.data },
          select: { binBytes: true, binSize: true },
        });
        // release exists (the token references it), but guard anyway
        if (!release) {
          set.status = 404;
          return { error: "not_found", message: "release does not exist" };
        }
        set.status = 200;
        set.headers["content-type"] = "application/octet-stream";
        set.headers["content-length"] = String(release.binSize);
        return new Uint8Array(release.binBytes);
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
