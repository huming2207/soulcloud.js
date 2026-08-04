/**
 * Logging-related API routes: firmware artifact upload, log query with
 * on-demand decoding, and device firmware state management.
 *
 * Error mapping follows the command-batch conventions:
 *   400 invalid_request, 404 not_found, 409 build_id_conflict,
 *   413 payload_too_large, 422 invalid_elf, 500 internal.
 *
 * Every path/query parameter is validated with Zod before use and all
 * handlers are wrapped with `handleApiError` so unexpected failures never
 * leak internal error messages (Elysia's onError hook is unreliable under
 * Bun, see app.ts).
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  ArtifactImportError,
  backfillDecodeState,
  computeBuildId,
  decodeEventsBatch,
  importArtifact,
  MAX_ELF_BYTES,
  type PrismaClient,
} from "@soulcloud/core";
import {
  CursorParam,
  LimitParam,
  UuidParam,
  handleApiError,
} from "./validate";

export function createLoggingRoutes(prisma: PrismaClient) {
  return new Elysia({ prefix: "/v1" })
    // --- firmware artifacts ------------------------------------------------

    .post("/firmware-artifacts", async ({ request, set }) => {
      try {
        // S5: reject oversized uploads BEFORE buffering the body. For
        // declared lengths this is a cheap header check; for chunked
        // requests the body stream is read with a hard cap and aborted.
        const declared = request.headers.get("content-length");
        const limit = MAX_ELF_BYTES + 64 * 1024;
        if (declared && Number(declared) > limit) {
          set.status = 413;
          return {
            error: "payload_too_large",
            message: `ELF exceeds ${MAX_ELF_BYTES} bytes`,
          };
        }
        let body: Uint8Array;
        if (declared === null && request.body) {
          // chunked: stream with a cap; abort (413) the moment it is passed
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
                return {
                  error: "payload_too_large",
                  message: `ELF exceeds ${MAX_ELF_BYTES} bytes`,
                };
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
        const form = await new Response(body, {
          headers: { "content-type": request.headers.get("content-type") ?? "multipart/form-data" },
        }).formData().catch(() => null);
        if (!form) {
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
        const file = form.get("file");

        if (typeof file !== "object" || file === null || !("arrayBuffer" in file)) {
          set.status = 400;
          return { error: "invalid_request", message: "file is required" };
        }

        const project = await prisma.project.findUnique({
          where: { id: projectId.data },
          select: { id: true },
        });
        if (!project) {
          set.status = 404;
          return { error: "project_not_found", message: "project does not exist" };
        }

        const elf = new Uint8Array(await (file as File).arrayBuffer());
        const buildId = computeBuildId(elf);
        const existing = await prisma.firmwareArtifact.findUnique({
          where: { projectId_buildId: { projectId: projectId.data, buildId } },
          select: { id: true },
        });

        const imported = await importArtifact(prisma, {
          projectId: projectId.data,
          elf,
          version: typeof version === "string" && version ? version : undefined,
        });
        const backfilled = existing
          ? 0
          : await backfillDecodeState(prisma, imported.artifactId, imported.buildId);
        set.status = existing ? 200 : 201;
        return {
          artifact_id: imported.artifactId,
          build_id: imported.buildId,
          import_state: "imported",
          tag_count: imported.tagCount,
          format_count: imported.formatCount,
          backfilled_events: backfilled,
        };
      } catch (error) {
        if (error instanceof ArtifactImportError) {
          switch (error.kind) {
            case "too_large":
              set.status = 413;
              return {
                error: "payload_too_large",
                message: `ELF exceeds ${MAX_ELF_BYTES} bytes`,
              };
            case "invalid_elf":
              set.status = 422;
              return { error: "invalid_elf", message: error.message };
            default:
              set.status = 500;
              return { error: "import_failed", message: "artifact import failed" };
          }
        }
        return handleApiError(error, set);
      }
    })

    .get("/firmware-artifacts", async ({ query, set }) => {
      try {
        const projectId = UuidParam.safeParse(String(query.project_id ?? ""));
        if (!projectId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "project_id (UUID) is required" };
        }
        const limit = LimitParam.safeParse(query.limit ?? 100);
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: "limit must be an integer between 1 and 500" };
        }
        const artifacts = await prisma.firmwareArtifact.findMany({
          where: { projectId: projectId.data },
          orderBy: { uploadedAt: "desc" },
          select: {
            id: true,
            buildId: true,
            version: true,
            elfSize: true,
            importState: true,
            uploadedAt: true,
            _count: { select: { logStrings: true } },
          },
          take: limit.data,
        });
        return {
          artifacts: artifacts.map((a) => ({
            artifact_id: a.id,
            build_id: a.buildId,
            version: a.version,
            elf_size: a.elfSize,
            import_state: a.importState,
            uploaded_at: a.uploadedAt,
            dictionary_entries: a._count.logStrings,
          })),
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- log query with on-demand decoding --------------------------------

    .get("/devices/:deviceId/logs", async ({ params, query, set }) => {
      try {
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const limit = LimitParam.safeParse(query.limit ?? 100);
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: "limit must be an integer between 1 and 500" };
        }
        let cursor: bigint | undefined;
        if (query.cursor !== undefined) {
          const c = CursorParam.safeParse(String(query.cursor));
          if (!c.success) {
            set.status = 400;
            return { error: "invalid_request", message: "cursor must be a positive integer" };
          }
          cursor = c.data;
        }
        const includeRaw = String(query.include_raw ?? "") === "1";

        const device = await prisma.device.findUnique({
          where: { id: deviceId.data },
          select: { id: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }

        const events = await prisma.rawLogEvent.findMany({
          where: { deviceId: deviceId.data, ...(cursor ? { id: { lt: cursor } } : {}) },
          orderBy: { id: "desc" },
          take: limit.data,
        });

        const decoded = await decodeEventsBatch(prisma, events);

        return {
          events: events.map((e, i) => ({
            id: e.id.toString(),
            received_at: e.receivedAt,
            device_time_ms: e.deviceTimeMs.toString(),
            sequence: e.sequence,
            packet_type: e.packetType,
            level: e.level,
            tag: decoded[i]!.tag,
            message: decoded[i]!.message,
            decode_state: e.decodeState,
            ...(includeRaw
              ? { raw_packet_b64: Buffer.from(e.rawPacket).toString("base64") }
              : {}),
          })),
          next_cursor:
            events.length === limit.data ? events[events.length - 1]!.id.toString() : null,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- device firmware state ---------------------------------------------

    .get("/devices/:deviceId/firmware-state", async ({ params, set }) => {
      try {
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const state = await prisma.deviceFirmwareState.findUnique({
          where: { deviceId: deviceId.data },
          include: { device: { select: { deviceUid: true, projectId: true } } },
        });
        if (!state) {
          set.status = 404;
          return { error: "firmware_state_not_found", message: "no firmware state reported" };
        }
        const artifact = await prisma.firmwareArtifact.findUnique({
          where: {
            projectId_buildId: { projectId: state.device.projectId, buildId: state.fwHash },
          },
          select: { id: true, version: true },
        });
        return {
          device_id: state.deviceId,
          device_uid: state.device.deviceUid,
          fw_hash: state.fwHash,
          artifact_id: artifact?.id ?? null,
          artifact_version: artifact?.version ?? null,
          reported_at: state.reportedAt,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/devices/:deviceId/firmware-state", async ({ params, body, set }) => {
      try {
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const parsed = z
          .object({ artifact_id: z.string().uuid() })
          .strict()
          .safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "artifact_id (uuid) is required" };
        }
        const [device, artifact] = await Promise.all([
          prisma.device.findUnique({
            where: { id: deviceId.data },
            select: { projectId: true },
          }),
          prisma.firmwareArtifact.findUnique({
            where: { id: parsed.data.artifact_id },
            select: { id: true, buildId: true, projectId: true },
          }),
        ]);
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }
        if (!artifact) {
          set.status = 404;
          return { error: "artifact_not_found", message: "artifact does not exist" };
        }
        // M3: an artifact may only be bound to devices in its own project
        if (artifact.projectId !== device.projectId) {
          set.status = 403;
          return { error: "artifact_project_mismatch", message: "artifact belongs to a different project" };
        }
        await prisma.deviceFirmwareState.upsert({
          where: { deviceId: deviceId.data },
          update: { fwHash: artifact.buildId, reportedAt: new Date() },
          create: { deviceId: deviceId.data, fwHash: artifact.buildId },
        });
        // previously unknown-fw events become decodable
        const backfilled = await backfillDecodeState(prisma, artifact.id, artifact.buildId);
        return {
          device_id: deviceId.data,
          artifact_id: parsed.data.artifact_id,
          backfilled_events: backfilled,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
