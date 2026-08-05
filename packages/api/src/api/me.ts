/**
 * Current-user route (P0 UI prerequisite): the frontend needs to know who
 * is logged in and which projects they can pick from. Registration creates
 * a personal project (`auth.ts`), but until now nothing could list it.
 *
 *   GET /v1/me -> { user_id, username, projects: [{project_id, name,
 *                  device_count}] }
 */

import { Elysia } from "elysia";
import type { JwtConfig, PrismaClient } from "@soulcloud/core";
import { authenticateRequest, handleApiError } from "./validate";

export function createMeRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1" })
    .get("/me", async ({ request, set }) => {
      try {
        const authUser = await authenticateRequest(prisma, jwt, request);
        if (!authUser) {
          set.status = 401;
          return { error: "unauthorized", message: "authentication required" };
        }
        const links = await prisma.userProject.findMany({
          where: { userId: authUser.user.id },
          select: {
            project: {
              select: {
                id: true,
                name: true,
                _count: { select: { devices: true } },
              },
            },
          },
          orderBy: { project: { name: "asc" } },
        });
        return {
          user_id: authUser.user.id,
          username: authUser.user.username,
          projects: links.map((l) => ({
            project_id: l.project.id,
            name: l.project.name,
            device_count: l.project._count.devices,
          })),
        };
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
