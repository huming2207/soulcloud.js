/**
 * OTA rollout routes: create (auto/grouped strategies), detail, and the
 * lifecycle operations pause / resume / abort / rollback.
 *
 * Error mapping follows the deploy conventions (400 invalid_targets,
 * 403 forbidden, 404 not_found, 500 internal). The device pool is an
 * explicit snapshot — fleet selectors are a later milestone.
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  MAX_OTA_TARGETS,
  OtaError,
  abortRollout,
  createOtaRollout,
  pauseRollout,
  resumeRollout,
  rollbackRollout,
  type JwtConfig,
  type PrismaClient,
} from "@soulcloud/core";
import {
  UuidParam,
  authenticateRequest,
  handleApiError,
  userCanAccessProject,
} from "./validate";

const CreateRolloutBody = z
  .object({
    strategy: z.enum(["auto", "grouped"]),
    device_ids: z.array(UuidParam).max(MAX_OTA_TARGETS).optional(),
    ratios: z
      .array(z.number().gt(0).lte(1))
      .max(10)
      .optional(),
    phases: z
      .array(
        z.object({
          device_ids: z.array(UuidParam).min(1).max(MAX_OTA_TARGETS),
        }),
      )
      .max(10)
      .optional(),
    from_release_id: UuidParam.optional(),
    success_ratio: z.number().gt(0).lte(1).optional(),
    min_sample: z.number().int().min(0).max(10_000).optional(),
    phase_timeout_hours: z.number().int().min(1).max(24 * 30).optional(),
    stuck_hours: z.number().int().min(1).max(24 * 30).optional(),
    manual_approval: z.boolean().optional(),
  })
  .strict();

export function createRolloutRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    // --- create ------------------------------------------------------------

    .post("/firmware-releases/:id/rollouts", async ({ request, params, set }) => {
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
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          set.status = 400;
          return { error: "invalid_request", message: "expected JSON body" };
        }
        const parsed = CreateRolloutBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return {
            error: "invalid_request",
            message: `invalid rollout definition: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          };
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
        try {
          const created = await createOtaRollout(prisma, {
            projectId: release.projectId,
            releaseId: release.id,
            fromReleaseId: parsed.data.from_release_id,
            strategy: parsed.data.strategy,
            deviceIds: parsed.data.device_ids,
            ratios: parsed.data.ratios,
            groups: parsed.data.phases,
            successRatio: parsed.data.success_ratio,
            minSample: parsed.data.min_sample,
            phaseTimeoutHours: parsed.data.phase_timeout_hours,
            stuckHours: parsed.data.stuck_hours,
            manualApproval: parsed.data.manual_approval,
            createdBy: authUser.user.id,
          });
          set.status = 201;
          return {
            rollout_id: created.rolloutId,
            phases: created.phases,
            job_id: created.jobId,
          };
        } catch (error) {
          if (error instanceof OtaError) {
            switch (error.kind) {
              case "empty_targets":
              case "duplicate_targets":
              case "too_many_targets":
              case "invalid_ratios":
              case "invalid_from_release":
              case "no_phases":
              case "groups_overlap":
                set.status = 400;
                return { error: "invalid_targets", message: error.message };
              case "target_not_found":
              case "target_not_in_project":
              case "release_not_in_project":
                set.status = 404;
                return { error: "target_devices_not_found", message: error.message };
              case "database":
                break;
            }
          }
          throw error;
        }
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- detail ------------------------------------------------------------

    .get("/ota-rollouts/:id", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        const rollout = await prisma.otaRollout.findUnique({
          where: { id: id.data },
          select: {
            id: true,
            projectId: true,
            releaseId: true,
            fromReleaseId: true,
            state: true,
            strategy: true,
            successRatio: true,
            minSample: true,
            phaseTimeoutHours: true,
            stuckHours: true,
            manualApproval: true,
            rollbackJobId: true,
            createdAt: true,
            pool: { orderBy: { sortIdx: "asc" }, select: { deviceId: true, sortIdx: true } },
            phases: {
              orderBy: { index: "asc" },
              select: {
                index: true,
                ratio: true,
                groupId: true,
                state: true,
                targetCount: true,
                jobId: true,
                activatedAt: true,
                completedAt: true,
                job: {
                  select: {
                    targets: {
                      select: { state: true, resultCode: true, confirmedAt: true },
                    },
                  },
                },
              },
            },
          },
        });
        if (!rollout) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        if (!(await userCanAccessProject(prisma, authUser.user.id, rollout.projectId))) {
          set.status = 403;
          return { error: "forbidden", message: "not a member of this project" };
        }
        const summarize = (targets: Array<{ state: string }>) => {
          const summary: Record<string, number> = {};
          for (const t of targets) summary[t.state] = (summary[t.state] ?? 0) + 1;
          return summary;
        };
        return {
          rollout_id: rollout.id,
          release_id: rollout.releaseId,
          from_release_id: rollout.fromReleaseId,
          state: rollout.state,
          strategy: rollout.strategy,
          success_ratio: rollout.successRatio,
          min_sample: rollout.minSample,
          phase_timeout_hours: rollout.phaseTimeoutHours,
          stuck_hours: rollout.stuckHours,
          manual_approval: rollout.manualApproval,
          rollback_job_id: rollout.rollbackJobId,
          created_at: rollout.createdAt,
          pool_size: rollout.pool.length,
          phases: rollout.phases.map((p) => ({
            index: p.index,
            ratio: p.ratio,
            group_id: p.groupId,
            state: p.state,
            target_count: p.targetCount,
            job_id: p.jobId,
            activated_at: p.activatedAt,
            completed_at: p.completedAt,
            summary: p.job ? summarize(p.job.targets) : null,
          })),
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    // --- lifecycle ---------------------------------------------------------

    .post("/ota-rollouts/:id/pause", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        if (!(await canManageRollout(prisma, jwt, authUser.user.id, id.data))) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        const paused = await pauseRollout(prisma, id.data);
        if (!paused) {
          set.status = 409;
          return { error: "wrong_state", message: "rollout is not running" };
        }
        return { rollout_id: id.data, state: "paused" };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/ota-rollouts/:id/resume", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        if (!(await canManageRollout(prisma, jwt, authUser.user.id, id.data))) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        const resumed = await resumeRollout(prisma, id.data);
        if (!resumed) {
          set.status = 409;
          return { error: "wrong_state", message: "rollout is not paused" };
        }
        return { rollout_id: id.data, state: "running" };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/ota-rollouts/:id/abort", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        if (!(await canManageRollout(prisma, jwt, authUser.user.id, id.data))) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        const aborted = await abortRollout(prisma, id.data);
        if (!aborted) {
          set.status = 409;
          return { error: "wrong_state", message: "rollout is not running or paused" };
        }
        return { rollout_id: id.data, state: "aborted" };
      } catch (error) {
        return handleApiError(error, set);
      }
    })

    .post("/ota-rollouts/:id/rollback", async ({ request, params, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const id = UuidParam.safeParse(params.id);
        if (!id.success) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        if (!(await canManageRollout(prisma, jwt, authUser.user.id, id.data))) {
          set.status = 404;
          return { error: "not_found", message: "rollout does not exist" };
        }
        try {
          const result = await rollbackRollout(prisma, id.data);
          return {
            rollout_id: id.data,
            state: "aborted",
            rollback_job_id: result.rollbackJobId,
            target_devices: result.targetDevices,
          };
        } catch (error) {
          if (error instanceof OtaError) {
            if (error.kind === "not_found") {
              set.status = 404;
              return { error: "not_found", message: error.message };
            }
            if (error.kind === "rollback_unavailable") {
              set.status = 409;
              return { error: "rollback_unavailable", message: error.message };
            }
          }
          throw error;
        }
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}

/** Membership + existence check for rollout lifecycle operations. */
async function canManageRollout(
  prisma: PrismaClient,
  jwt: JwtConfig,
  userId: string,
  rolloutId: string,
): Promise<boolean> {
  const rollout = await prisma.otaRollout.findUnique({
    where: { id: rolloutId },
    select: { projectId: true },
  });
  if (!rollout) return false;
  return userCanAccessProject(prisma, userId, rollout.projectId);
}
