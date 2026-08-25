/**
 * Elysia application factory: health endpoints + the command-batch API.
 *
 * Error mapping mirrors the Rust soulcloud-api exactly:
 *   - empty/duplicate/too-many targets      -> 400 invalid_targets
 *   - missing targets                        -> 404 target_devices_not_found
 *   - unsafe device UID                      -> 422 invalid_device_uid
 *   - malformed request body                 -> 400 invalid_request
 *   - queue/database failures                -> 500 command_queue_unavailable
 *     (details are logged, never exposed to the client)
 *
 * Note: body validation is done manually with Zod inside the handler instead
 * of Elysia's schema validation, because (a) Elysia's ValidationError
 * response shape does not match our { error, message } contract. Route-local
 * error mapping also keeps typed domain errors explicit at their call sites.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  CommandQueueError,
  DeviceCommandSchema,
  enqueueBatch,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import { createAuthRoutes } from "./auth";
import { createLoggingRoutes } from "./logging";
import { createLogStreamRoutes } from "./log-stream";
import { createCommandStreamRoutes } from "./command-stream";
import { createOtaStreamRoutes } from "./ota-stream";
import { createStatusStreamRoutes } from "./status-stream";
import { createNotificationsStreamRoutes } from "./notifications-stream";
import { createFirmwareRoutes } from "./firmware";
import { createRolloutRoutes } from "./rollout";
import { createMeRoutes } from "./me";
import { createDeviceRoutes } from "./devices";
import { authenticateRequest, userCanAccessProject } from "./validate";
import { createPluginManagerRoutes } from "./plugin-manager";

const MAX_BATCH_TARGETS = 1000;

const CreateCommandBatchBody = z
  .object({
    device_ids: z.array(z.string().uuid()).max(MAX_BATCH_TARGETS),
    command: DeviceCommandSchema,
    /**
     * Delivery deadline in seconds (NULL/absent = never expires; the
     * command is retried until the device completes it).
     */
    delivery_timeout_seconds: z.coerce.number().int().positive().optional(),
  })
  .strict();

export interface StreamOptions {
  /**
   * Debounce window (ms) for merging burst WS pushes per command batch /
   * OTA job. Tests inject a short value; defaults to 250ms per stream.
   */
  debounceMs?: number;
  /** WS token-expiry re-check interval (ms); tests inject a short value. */
  expCheckIntervalMs?: number;
  /** Per-process WS connection cap; tests inject a small value. */
  maxConnections?: number;
}

export interface AuthWorkOptions {
  /** Maximum simultaneous memory-hard password hash/verify operations. */
  argon2Concurrency?: number;
  /** Hard bound for the in-process username failure tracker. */
  loginFailureCapacity?: number;
}

export interface PluginManagerOptions {
  internalUrl: string;
  serviceToken?: string;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  uiSessionSecret?: string;
  uiSessionTtlSeconds?: number;
}

export function createApp(
  prisma: PrismaClient,
  jwt: JwtConfig,
  otaTargetTtlSeconds = 15 * 60,
  streamOptions: StreamOptions = {},
  maxJsonBodyBytes = 1024 * 1024,
  authWorkOptions: AuthWorkOptions = {},
  pluginManagerOptions?: PluginManagerOptions,
) {
  // C1 (round-5): never fall back to a hardcoded secret. The caller MUST
  // pass the configured JwtConfig (index.ts wires .env; tests inject
  // TEST_JWT). A runtime `undefined` (JS callers) must fail, not degrade.
  if (!jwt) {
    throw new Error(
      "createApp requires a JwtConfig: JWT_SECRET must be set in .env and wired through the config",
    );
  }
  const auth = jwt;
  return new Elysia()
    .onRequest(({ request, set }) => {
      // WEB-09: reject oversized non-multipart bodies before any JSON parse
      // cost (JSON parsing runs before handler authentication). Firmware
      // uploads are multipart and streamed with their own caps — exempt
      // here; Bun's global maxRequestBodySize bounds those separately.
      const contentType = request.headers.get("content-type") ?? "";
      const path = new URL(request.url).pathname;
      const pluginArtifactUpload = request.method === "POST" && /^\/v1\/plugin-installations\/[^/]+\/debugger\/artifacts$/.test(path);
      if (contentType.includes("multipart/form-data") || pluginArtifactUpload) return;
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > maxJsonBodyBytes) {
        set.status = 413;
        return new Response(
          JSON.stringify({ error: "payload_too_large", message: "request body too large" }),
          { status: 413, headers: { "content-type": "application/json" } },
        );
      }
    })
    .get("/health/live", () => ({ status: "ok" }))
    .get("/health/ready", async ({ set }) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: "ready" };
      } catch {
        set.status = 503;
        return { status: "not_ready" };
      }
    })
    .post("/v1/command-batches", async ({ body, request, set }) => {
      // G group: authenticated users only
      const authUser = await authenticateRequest(prisma, auth, request);
      if (!authUser) {
        set.status = 401;
        return { error: "unauthorized", message: "authentication required" };
      }
      const parsed = CreateCommandBatchBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return {
          error: "invalid_request",
          message: formatZodIssues(parsed.error.issues),
        };
      }
      try {
        // project membership: every target device must belong to a project
        // the caller can access (missing devices are reported by enqueue)
        const targets = await prisma.device.findMany({
          where: { id: { in: parsed.data.device_ids } },
          select: { projectId: true },
        });
        const projectIds = new Set(targets.map((d) => d.projectId));
        for (const pid of projectIds) {
          if (!(await userCanAccessProject(prisma, authUser.user.id, pid))) {
            set.status = 403;
            return { error: "forbidden", message: "not a member of a target device's project" };
          }
        }
        const batch = await enqueueBatch(
          prisma,
          parsed.data.device_ids,
          parsed.data.command,
          {
            deliveryTimeoutSeconds: parsed.data.delivery_timeout_seconds,
            provenance: { originType: "human", originUserId: authUser.user.id },
          },
        );
        set.status = 202;
        return { batch_id: batch.id, device_count: batch.deviceCount };
      } catch (error) {
        return mapQueueError(error, set);
      }
    })
    .use(createAuthRoutes(prisma, auth, authWorkOptions))
    .use(createLoggingRoutes(prisma, auth))
    .use(createLogStreamRoutes(prisma, auth, { databaseUrl: process.env.DATABASE_URL ?? "", debounceMs: streamOptions.debounceMs, expCheckIntervalMs: streamOptions.expCheckIntervalMs, maxConnections: streamOptions.maxConnections }))
    .use(createCommandStreamRoutes(prisma, auth, { debounceMs: streamOptions.debounceMs, expCheckIntervalMs: streamOptions.expCheckIntervalMs, maxConnections: streamOptions.maxConnections }))
    .use(createOtaStreamRoutes(prisma, auth, { debounceMs: streamOptions.debounceMs, expCheckIntervalMs: streamOptions.expCheckIntervalMs, maxConnections: streamOptions.maxConnections }))
    .use(createStatusStreamRoutes(prisma, auth, { databaseUrl: process.env.DATABASE_URL ?? "", debounceMs: streamOptions.debounceMs, expCheckIntervalMs: streamOptions.expCheckIntervalMs, maxConnections: streamOptions.maxConnections }))
    .use(createNotificationsStreamRoutes(prisma, auth, { databaseUrl: process.env.DATABASE_URL ?? "", expCheckIntervalMs: streamOptions.expCheckIntervalMs, maxConnections: streamOptions.maxConnections }))
    .use(createFirmwareRoutes(prisma, auth, otaTargetTtlSeconds))
    .use(createRolloutRoutes(prisma, auth, otaTargetTtlSeconds))
    .use(createMeRoutes(prisma, auth))
    .use(createDeviceRoutes(prisma, auth))
    .use(createPluginManagerRoutes(prisma, auth, pluginManagerOptions));
}

function formatZodIssues(
  issues: z.ZodIssue[],
): string {
  return issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function mapQueueError(
  error: unknown,
  set: { status?: number | string },
): { error: string; message: string } {
  if (error instanceof CommandQueueError) {
    switch (error.kind) {
      case "empty_targets":
      case "duplicate_targets":
      case "too_many_targets":
        set.status = 400;
        return { error: "invalid_targets", message: error.message };
      case "missing_targets":
        set.status = 404;
        return { error: "target_devices_not_found", message: error.message };
      case "invalid_device_uid":
        set.status = 422;
        return { error: "invalid_device_uid", message: error.message };
      case "invalid_provenance":
        set.status = 500;
        return { error: "invalid_provenance", message: "command provenance is invalid" };
      default:
        console.error(`[soulcloudjs] command queue failure: ${error.message}`);
        set.status = 500;
        return {
          error: "command_queue_unavailable",
          message: "device command queue is unavailable",
        };
    }
  }
  console.error(`[soulcloudjs] command queue failure: ${(error as Error).message}`);
  set.status = 500;
  return {
    error: "command_queue_unavailable",
    message: "device command queue is unavailable",
  };
}
