/**
 * Device management routes (P0 UI prerequisites).
 *
 *   GET  /v1/projects/:id/devices     device list (offset-paginated)
 *   GET  /v1/devices/:id              device detail
 *   POST /v1/devices                  create a device (MQTT credential
 *                                     shown once, same contract as the
 *                                     credentials endpoint)
 *   GET  /v1/devices/:id/commands     per-device command history with
 *                                     decoded payloads and results
 *   GET  /v1/command-batches/:id      batch detail with per-device results
 *
 * Error mapping follows the project conventions: 400 invalid_request,
 * 401 unauthorized, 403 forbidden, 404 not_found, 409 <field>_taken,
 * 422 invalid_device_uid, 500 internal.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  decodeDeviceCommandExecution,
  decodeDeviceCommandResult,
  generateDevicePassword,
  hashPassword,
  isValidDeviceUid,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import {
  CursorParam,
  LimitParam,
  OffsetParam,
  UuidParam,
  authenticateRequest,
  handleApiError,
  userCanAccessProject,
} from "./validate";

const DEVICE_UID_MAX = 128;
const ASSIGNED_ID_MAX = 128;

const CreateDeviceBody = z
  .object({
    project_id: z.string().uuid(),
    assigned_id: z.string().trim().min(1).max(ASSIGNED_ID_MAX),
    device_uid: z.string().trim().min(1).max(DEVICE_UID_MAX),
  })
  .strict();

/**
 * Recursively converts MessagePack-decoded values to JSON-safe ones:
 * bigint -> string (no precision loss), Uint8Array -> base64. Nested
 * arrays/objects are walked; all other scalars pass through unchanged.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

/**
 * Decodes a stored command payload (MessagePack DeviceCommandExecution)
 * down to the human-facing {cmd, args}. Payloads are written by our own
 * enqueue path, so a decode failure is a bug-level anomaly: log it and
 * surface `command: null` rather than 500-ing the whole list.
 */
function decodeCommandPayload(
  payload: Uint8Array,
): { cmd: string; args: unknown } | null {
  try {
    const execution = decodeDeviceCommandExecution(payload);
    return { cmd: execution.cmd, args: jsonSafe(execution.args ?? null) };
  } catch (error) {
    console.error(`[soulcloud-api] undecodable command payload: ${(error as Error).message}`);
    return null;
  }
}

/** Decodes a stored result packet (DeviceCommandResult) to {code, payload}. */
function decodeResultPacket(
  packet: Uint8Array,
): { code: number; payload: unknown } | null {
  try {
    const result = decodeDeviceCommandResult(packet);
    return { code: result.code, payload: jsonSafe(result.payload ?? null) };
  } catch (error) {
    console.error(`[soulcloud-api] undecodable command result packet: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Extracts the violated unique field names from a Prisma P2002 error.
 *
 * Prisma 7 with the driver adapter reports them under
 * `meta.driverAdapterError.cause.constraint.fields`; older formats used
 * `meta.target` (string or array). Both are handled; empty means unknown.
 */
function uniqueViolationFields(error: unknown): string[] {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: unknown }).code !== "P2002"
  ) {
    return [];
  }
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  const adapter = meta?.driverAdapterError as
    | { cause?: { constraint?: { fields?: unknown } } }
    | undefined;
  const fields = adapter?.cause?.constraint?.fields;
  if (Array.isArray(fields)) return fields.map(String);
  return [];
}

export function createDeviceRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    // --- device list -------------------------------------------------------

    .get("/projects/:projectId/devices", async ({ request, set, params }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const projectId = UuidParam.safeParse(String(params.projectId ?? ""));
        if (!projectId.success) {
          set.status = 400;
          return { error: "invalid_request", message: "project id must be a UUID" };
        }
        const url = new URL(request.url);
        const limit = LimitParam.safeParse(url.searchParams.get("limit") ?? "100");
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: "limit must be an integer 1..500" };
        }
        const offset = OffsetParam.safeParse(url.searchParams.get("offset") ?? "0");
        if (!offset.success) {
          set.status = 400;
          return { error: "invalid_request", message: "offset must be a non-negative integer" };
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
          set.status = 404;
          return { error: "not_found", message: "project does not exist" };
        }
        const [total, rows] = await Promise.all([
          prisma.device.count({ where: { projectId: projectId.data } }),
          prisma.device.findMany({
            where: { projectId: projectId.data },
            orderBy: { assignedId: "asc" },
            skip: offset.data,
            take: limit.data,
            select: {
              id: true,
              deviceUid: true,
              assignedId: true,
              authRevoked: true,
              firmwareState: {
                select: { fwHash: true, reportedAt: true },
              },
            },
          }),
        ]);
        return {
          total,
          devices: rows.map((d) => ({
            device_id: d.id,
            device_uid: d.deviceUid,
            assigned_id: d.assignedId,
            auth_revoked: d.authRevoked,
            firmware: d.firmwareState
              ? {
                  fw_hash: d.firmwareState.fwHash,
                  reported_at: d.firmwareState.reportedAt,
                }
              : null,
          })),
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- device detail -----------------------------------------------------

    .get("/devices/:deviceId", async ({ request, set, params }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "device does not exist" };
        }
        const device = await prisma.device.findUnique({
          where: { id: id.data },
          select: {
            id: true,
            deviceUid: true,
            assignedId: true,
            projectId: true,
            authRevoked: true,
            nextCommandSeq: true,
            firmwareState: {
              select: { fwHash: true, reportedAt: true },
            },
          },
        });
        if (!device) {
          set.status = 404;
          return { error: "not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 404;
          return { error: "not_found", message: "device does not exist" };
        }
        return {
          device_id: device.id,
          device_uid: device.deviceUid,
          assigned_id: device.assignedId,
          project_id: device.projectId,
          auth_revoked: device.authRevoked,
          next_command_sequence: device.nextCommandSeq.toString(),
          firmware: device.firmwareState
            ? {
                fw_hash: device.firmwareState.fwHash,
                reported_at: device.firmwareState.reportedAt,
              }
            : null,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- create ------------------------------------------------------------

    .post("/devices", async ({ request, body, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const parsed = CreateDeviceBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "assigned_id and device_uid are required (1..128 chars)" };
        }
        // the MQTT username/clientId IS the device_uid, so it must be safe
        // to embed in topic segments (same rule the enqueue path enforces)
        if (!isValidDeviceUid(parsed.data.device_uid)) {
          set.status = 422;
          return {
            error: "invalid_device_uid",
            message: "device_uid must be non-empty and contain no '/', '+', '#' or whitespace",
          };
        }
        const project = await prisma.project.findUnique({
          where: { id: parsed.data.project_id },
          select: { id: true },
        });
        if (!project) {
          set.status = 404;
          return { error: "project_not_found", message: "project does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, parsed.data.project_id))) {
          set.status = 404;
          return { error: "not_found", message: "project does not exist" };
        }
        // credential contract identical to POST /devices/:id/credentials:
        // the password is generated server-side, hashed with argon2id and
        // shown exactly once
        const password = generateDevicePassword();
        const passwordHash = await hashPassword(password);
        try {
          const created = await prisma.device.create({
            data: {
              projectId: parsed.data.project_id,
              assignedId: parsed.data.assigned_id,
              deviceUid: parsed.data.device_uid,
              passwordHash,
            },
            select: { id: true },
          });
          set.status = 201;
          return {
            device_id: created.id,
            device_uid: parsed.data.device_uid,
            assigned_id: parsed.data.assigned_id,
            mqtt_username: parsed.data.device_uid,
            mqtt_password: password,
            note: "the password is shown only once; the device must store it",
          };
        } catch (error) {
          const fields = uniqueViolationFields(error);
          if (fields.length > 0) {
            set.status = 409;
            return fields.includes("device_uid")
              ? { error: "device_uid_taken", message: "a device with this device_uid already exists" }
              : { error: "assigned_id_taken", message: "a device with this assigned_id already exists in the project" };
          }
          throw error;
        }
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- per-device command history ----------------------------------------

    .get("/devices/:deviceId/commands", async ({ request, set, params }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(String(params.deviceId ?? ""));
        if (!id.success) {
          set.status = 400;
          return { error: "invalid_request", message: "deviceId must be a UUID" };
        }
        const url = new URL(request.url);
        const limit = LimitParam.safeParse(url.searchParams.get("limit") ?? "100");
        if (!limit.success) {
          set.status = 400;
          return { error: "invalid_request", message: "limit must be an integer 1..500" };
        }
        let cursor: bigint | undefined;
        const cursorRaw = url.searchParams.get("cursor");
        if (cursorRaw !== null) {
          const c = CursorParam.safeParse(cursorRaw);
          if (!c.success) {
            set.status = 400;
            return { error: "invalid_request", message: "cursor must be a positive integer (a command sequence)" };
          }
          cursor = c.data;
        }
        const device = await prisma.device.findUnique({
          where: { id: id.data },
          select: { id: true, projectId: true },
        });
        if (!device) {
          set.status = 404;
          return { error: "not_found", message: "device does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, device.projectId))) {
          set.status = 404;
          return { error: "not_found", message: "device does not exist" };
        }
        const rows = await prisma.deviceCommand.findMany({
          where: { deviceId: id.data, ...(cursor ? { sequence: { lt: cursor } } : {}) },
          orderBy: { sequence: "desc" },
          take: limit.data + 1,
          select: {
            id: true,
            batchId: true,
            sequence: true,
            state: true,
            payload: true,
            resultPacket: true,
            resultCode: true,
            createdAt: true,
            deliveryExpiresAt: true,
            deviceCompletedAt: true,
          },
        });
        const hasMore = rows.length > limit.data;
        const items = hasMore ? rows.slice(0, limit.data) : rows;
        const last = items[items.length - 1];
        return {
          commands: items.map((c) => {
            const decoded = decodeCommandPayload(c.payload);
            return {
              command_id: c.id,
              batch_id: c.batchId,
              sequence: c.sequence.toString(),
              command: decoded,
              state: c.state,
              result_code: c.resultCode,
              result: c.resultPacket ? decodeResultPacket(c.resultPacket) : null,
              created_at: c.createdAt,
              delivery_expires_at: c.deliveryExpiresAt,
              device_completed_at: c.deviceCompletedAt,
            };
          }),
          next_cursor: hasMore && last ? last.sequence.toString() : null,
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- batch detail ------------------------------------------------------

    .get("/command-batches/:id", async ({ request, set, params }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(String(params.id ?? ""));
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "batch does not exist" };
        }
        const batch = await prisma.commandBatch.findUnique({
          where: { id: id.data },
          include: {
            commands: {
              include: {
                device: { select: { deviceUid: true, projectId: true } },
              },
            },
          },
        });
        if (!batch) {
          set.status = 404;
          return { error: "not_found", message: "batch does not exist" };
        }
        // a batch may span devices from several projects the user can
        // access; every target device's project must be one of theirs
        const links = await prisma.userProject.findMany({
          where: { userId: authUser.user.id },
          select: { projectId: true },
        });
        const accessible = new Set(links.map((l) => l.projectId));
        if (!batch.commands.every((c) => accessible.has(c.device.projectId))) {
          set.status = 404;
          return { error: "not_found", message: "command batch does not exist" };
        }
        const summary: Record<string, number> = {};
        for (const c of batch.commands) {
          summary[c.state] = (summary[c.state] ?? 0) + 1;
        }
        return {
          batch_id: batch.id,
          device_count: batch.deviceCount,
          created_at: batch.createdAt,
          summary,
          commands: batch.commands.map((c) => {
            const decoded = decodeCommandPayload(c.payload);
            return {
              command_id: c.id,
              device_id: c.deviceId,
              device_uid: c.device.deviceUid,
              sequence: c.sequence.toString(),
              command: decoded,
              state: c.state,
              result_code: c.resultCode,
              result: c.resultPacket ? decodeResultPacket(c.resultPacket) : null,
              created_at: c.createdAt,
              delivery_expires_at: c.deliveryExpiresAt,
              device_completed_at: c.deviceCompletedAt,
            };
          }),
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
