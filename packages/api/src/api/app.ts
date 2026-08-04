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
 * response shape does not match our { error, message } contract, and (b) the
 * onError lifecycle hook is not reliably invoked under Bun in this version.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  CommandQueueError,
  DeviceCommandSchema,
  enqueueBatch,
  type PrismaClient,
} from "@soulcloud/core";
import { createLoggingRoutes } from "./logging";

const MAX_BATCH_TARGETS = 1000;

const CreateCommandBatchBody = z
  .object({
    device_ids: z.array(z.string().uuid()).max(MAX_BATCH_TARGETS),
    command: DeviceCommandSchema,
  })
  .strict();

export function createApp(prisma: PrismaClient) {
  return new Elysia()
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
    .post("/v1/command-batches", async ({ body, set }) => {
      const parsed = CreateCommandBatchBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return {
          error: "invalid_request",
          message: formatZodIssues(parsed.error.issues),
        };
      }
      try {
        const batch = await enqueueBatch(
          prisma,
          parsed.data.device_ids,
          parsed.data.command,
        );
        set.status = 202;
        return { batch_id: batch.id, device_count: batch.deviceCount };
      } catch (error) {
        return mapQueueError(error, set);
      }
    })
    .use(createLoggingRoutes(prisma));
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
