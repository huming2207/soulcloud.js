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
  CREDENTIAL_REVOKED_CHANNEL,
  decodeEventsBatch,
  generateDevicePassword,
  hashPassword,
  importArtifact,
  MAX_ELF_BYTES,
  ON9LOG_LEVEL_NAMES,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import {
  CursorParam,
  LimitParam,
  UuidParam,
  authenticateRequest,
  handleApiError,
  userCanAccessProject,
} from "./validate";

/** Export caps: bound both the scan and the response size. */
const EXPORT_MAX_ROWS = 100_000;
const EXPORT_DEFAULT_ROWS = 50_000;
/** Rows per keyset batch (one query + one decode pass per chunk). */
const EXPORT_BATCH_ROWS = 500;

/** CSV cell escaping (RFC 4180: quote when the value contains commas,
 *  quotes or newlines; double inner quotes). */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function createLoggingRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    // --- firmware artifacts ------------------------------------------------

    .post("/firmware-artifacts", async ({ request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
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
        if (!(await userCanAccessProject(prisma, authUser.user.id, projectId.data))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
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

    .get("/firmware-artifacts", async ({ query, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
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
        // H1: project membership is required to list artifacts
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

    .get("/devices/:deviceId/logs", async ({ params, query, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
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
          select: { id: true, projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
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

    // --- log export (time-ranged CSV download) -----------------------------

    .get("/devices/:deviceId/logs/export", async ({ params, query, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        // from is REQUIRED (bounds the scan); to defaults to now
        const from = z.iso.datetime().safeParse(String(query.from ?? ""));
        if (!from.success) {
          set.status = 400;
          return { error: "invalid_request", message: "from must be an ISO 8601 timestamp" };
        }
        const toRaw = query.to === undefined ? undefined : String(query.to);
        let to: Date | undefined;
        if (toRaw !== undefined) {
          const parsed = z.iso.datetime().safeParse(toRaw);
          if (!parsed.success) {
            set.status = 400;
            return { error: "invalid_request", message: "to must be an ISO 8601 timestamp" };
          }
          to = new Date(parsed.data);
        }
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(EXPORT_MAX_ROWS)
          .default(EXPORT_DEFAULT_ROWS)
          .safeParse(query.limit);
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: `limit must be an integer between 1 and ${EXPORT_MAX_ROWS}` };
        }

        const device = await prisma.device.findUnique({
          where: { id: deviceId.data },
          select: { id: true, projectId: true, deviceUid: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }

        const fromDate = new Date(from.data);
        const toDate = to ?? new Date();
        if (fromDate.getTime() > toDate.getTime()) {
          set.status = 400;
          return { error: "invalid_request", message: "from must be earlier than to" };
        }

        set.headers["content-type"] = "text/csv; charset=utf-8";
        set.headers["content-disposition"] =
          `attachment; filename="${device.deviceUid}-logs.csv"`;

        // Stream the export: keyset pagination over raw_log_events (id
        // ascending within the receivedAt window) with on-demand decoding,
        // so a large export never buffers the whole result in memory.
        const encoder = new TextEncoder();
        const HEADER = "received_at,device_time_ms,sequence,packet_type,level,tag,message,decode_state\n";
        let cursor = 0n;
        let emitted = 0;
        let headerSent = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (emitted >= limit.data) {
              controller.close();
              return;
            }
            if (!headerSent) {
              headerSent = true;
              controller.enqueue(encoder.encode(HEADER));
            }
            const batchSize = Math.min(EXPORT_BATCH_ROWS, limit.data - emitted);
            const events = await prisma.rawLogEvent.findMany({
              where: {
                deviceId: device.id,
                id: { gt: cursor },
                receivedAt: { gte: fromDate, lte: toDate },
              },
              orderBy: { id: "asc" },
              take: batchSize,
            });
            if (events.length === 0) {
              controller.close();
              return;
            }
            const decoded = await decodeEventsBatch(prisma, events);
            const lines: string[] = [];
            for (let i = 0; i < events.length; i++) {
              const e = events[i]!;
              lines.push(
                [
                  e.receivedAt.toISOString(),
                  e.deviceTimeMs.toString(),
                  e.sequence,
                  e.packetType,
                  e.level === null ? "" : (ON9LOG_LEVEL_NAMES[e.level] ?? e.level),
                  decoded[i]?.tag,
                  decoded[i]?.message,
                  e.decodeState,
                ]
                  .map(csvCell)
                  .join(","),
              );
            }
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
            cursor = events[events.length - 1]!.id;
            emitted += events.length;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${device.deviceUid}-logs.csv"`,
          },
        });
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- device firmware state ---------------------------------------------

    .get("/devices/:deviceId/firmware-state", async ({ params, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
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
        // H1: the device's project membership is required to read the state
        if (!(await userCanAccessProject(prisma, authUser.user.id, state.device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
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

    // --- device credentials (G group: MQTT per-session auth) ---------------

    .post("/devices/:deviceId/credentials", async ({ params, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const device = await prisma.device.findUnique({
          where: { id: deviceId.data },
          select: { projectId: true, deviceUid: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        // issue fresh credentials (the device_uid stays the MQTT username;
        // the password is returned exactly once). Rotation replaces the
        // hash, so the old password dies immediately; a live session from
        // the old credentials is kicked (same "revoke = kick" semantics
        // as the revoke endpoint, audit M3).
        const password = generateDevicePassword();
        const passwordHash = await hashPassword(password);
        await prisma.$transaction([
          prisma.device.update({
            where: { id: deviceId.data },
            data: { passwordHash, authRevoked: false },
          }),
          prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, ${device.deviceUid})`,
        ]);
        return {
          device_id: deviceId.data,
          mqtt_username: device.deviceUid,
          mqtt_password: password,
          note: "the password is shown only once; the device must store it",
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/devices/:deviceId/credentials/revoke", async ({ params, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const deviceId = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!deviceId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const device = await prisma.device.findUnique({
          where: { id: deviceId.data },
          select: { projectId: true, deviceUid: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "device_not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
        }
        // revoke + wake the broker so the device's LIVE session is killed
        // (not just refused on reconnect); pg_notify inside the transaction
        // is delivered only after commit
        await prisma.$transaction([
          prisma.device.update({
            where: { id: deviceId.data },
            data: { authRevoked: true },
          }),
          prisma.$executeRaw`SELECT pg_notify(${CREDENTIAL_REVOKED_CHANNEL}, ${device.deviceUid})`,
        ]);
        return { device_id: deviceId.data, revoked: true, session_killed: true };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/devices/:deviceId/firmware-state", async ({ params, body, request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
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
        // H1: membership is required BEFORE the write (a non-member must
        // never bind artifacts or mutate another project's device state)
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this device's project" };
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
