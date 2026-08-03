/**
 * Logging-related API routes: firmware artifact upload, log query with
 * on-demand decoding, and device firmware state management.
 *
 * Error mapping follows the command-batch conventions:
 *   400 invalid_request, 404 not_found, 409 build_id_conflict,
 *   413 payload_too_large, 422 invalid_elf, 500 internal.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  ArtifactImportError,
  backfillDecodeState,
  computeBuildId,
  decodeRawEvent,
  importArtifact,
  MAX_ELF_BYTES,
  type PrismaClient,
} from "@soulcloud/core";

const MAX_LOG_PAGE = 500;
const MAX_LOGS_DEFAULT = 100;

export function createLoggingRoutes(prisma: PrismaClient) {
  return new Elysia({ prefix: "/v1" })
    // --- firmware artifacts ------------------------------------------------

    .post("/firmware-artifacts", async ({ request, set }) => {
      const form = await request.formData().catch(() => null);
      if (!form) {
        set.status = 400;
        return { error: "invalid_request", message: "expected multipart/form-data" };
      }
      const projectId = String(form.get("project_id") ?? "");
      const version = form.get("version");
      const file = form.get("file");

      if (!projectId || typeof file !== "object" || file === null || !("arrayBuffer" in file)) {
        set.status = 400;
        return { error: "invalid_request", message: "file and project_id are required" };
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (!project) {
        set.status = 404;
        return { error: "project_not_found", message: "project does not exist" };
      }

      const elf = new Uint8Array(await (file as File).arrayBuffer());
      const buildId = computeBuildId(elf);
      const existing = await prisma.firmwareArtifact.findUnique({
        where: { buildId },
        select: { id: true },
      });

      try {
        const imported = await importArtifact(prisma, {
          projectId,
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
        throw error;
      }
    })

    .get("/firmware-artifacts", async ({ query, set }) => {
      const projectId = String(query.project_id ?? "");
      if (!projectId) {
        set.status = 400;
        return { error: "invalid_request", message: "project_id is required" };
      }
      const artifacts = await prisma.firmwareArtifact.findMany({
        where: { projectId },
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
        take: 100,
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
    })

    // --- log query with on-demand decoding --------------------------------

    .get("/devices/:deviceId/logs", async ({ params, query, set }) => {
      const deviceId = String(params.deviceId ?? "");
      const limit = Math.min(
        Number(query.limit ?? MAX_LOGS_DEFAULT) || MAX_LOGS_DEFAULT,
        MAX_LOG_PAGE,
      );
      const cursor = query.cursor ? BigInt(String(query.cursor)) : undefined;
      const includeRaw = String(query.include_raw ?? "") === "1";

      if (!deviceId) {
        set.status = 400;
        return { error: "invalid_request", message: "deviceId is required" };
      }

      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { id: true },
      });
      if (!device) {
        set.status = 404;
        return { error: "device_not_found", message: "device does not exist" };
      }

      const events = await prisma.rawLogEvent.findMany({
        where: { deviceId, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: { id: "desc" },
        take: limit,
      });

      const decoded = await Promise.all(
        events.map((e) => decodeRawEvent(prisma, e)),
      );

      return {
        events: events.map((e, i) => ({
          id: e.id.toString(),
          received_at: e.receivedAt,
          device_time_ms: e.deviceTimeMs,
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
          events.length === limit ? events[events.length - 1]!.id.toString() : null,
      };
    })

    // --- device firmware state ---------------------------------------------

    .get("/devices/:deviceId/firmware-state", async ({ params, set }) => {
      const deviceId = String(params.deviceId ?? "");
      const state = await prisma.deviceFirmwareState.findUnique({
        where: { deviceId },
        include: { device: { select: { deviceUid: true } } },
      });
      if (!state) {
        set.status = 404;
        return { error: "firmware_state_not_found", message: "no firmware state reported" };
      }
      const artifact = await prisma.firmwareArtifact.findUnique({
        where: { buildId: state.fwHash },
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
    })

    .post("/devices/:deviceId/firmware-state", async ({ params, body, set }) => {
      const deviceId = String(params.deviceId ?? "");
      const parsed = z
        .object({ artifact_id: z.string().uuid() })
        .strict()
        .safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid_request", message: "artifact_id (uuid) is required" };
      }
      const artifact = await prisma.firmwareArtifact.findUnique({
        where: { id: parsed.data.artifact_id },
        select: { id: true, buildId: true },
      });
      if (!artifact) {
        set.status = 404;
        return { error: "artifact_not_found", message: "artifact does not exist" };
      }
      await prisma.deviceFirmwareState.upsert({
        where: { deviceId },
        update: { fwHash: artifact.buildId, reportedAt: new Date() },
        create: { deviceId, fwHash: artifact.buildId },
      });
      // previously unknown-fw events become decodable
      const backfilled = await backfillDecodeState(prisma, artifact.id, artifact.buildId);
      return {
        device_id: deviceId,
        artifact_id: parsed.data.artifact_id,
        backfilled_events: backfilled,
      };
    });
}
