/**
 * Human-user authentication routes (G group).
 *
 *   POST /v1/auth/register  {username, password, email} -> creates the user
 *                            plus a personal project (user_projects)
 *   POST /v1/auth/login     {username, password} -> access + refresh tokens
 *   POST /v1/auth/refresh   {refresh_token} -> rotated token pair
 *   POST /v1/auth/logout    {refresh_token} -> revokes the token
 *
 * Access tokens are short-lived JWTs; refresh tokens are server-side,
 * revocable and rotated on every use (reuse detection revokes the chain).
 */

import { Elysia } from "elysia";
import { z } from "zod";
import {
  AuthError,
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type JwtConfig,
  type PrismaClient,
  verifyPassword,
} from "@soulcloud/core";
import { handleApiError } from "./validate";

const RegisterBody = z
  .object({
    username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
    password: z.string().min(8).max(128),
    email: z.string().email().max(254),
  })
  .strict();

const LoginBody = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

const RefreshBody = z
  .object({ refresh_token: z.string().min(1) })
  .strict();

export function createAuthRoutes(prisma: PrismaClient, jwt: JwtConfig) {
  return new Elysia({ prefix: "/v1/auth" })
    .post("/register", async ({ body, set }) => {
      try {
        const parsed = RegisterBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid registration payload" };
        }
        const { username, password, email } = parsed.data;
        const passwordHash = await hashPassword(password);
        // create the user and a personal project in one transaction
        const user = await prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: { username, passwordHash, email },
          });
          const project = await tx.project.create({
            data: { name: `${username}'s project` },
          });
          await tx.userProject.create({
            data: { userId: created.id, projectId: project.id },
          });
          return created;
        });
        const refreshToken = await issueRefreshToken(prisma, user.id, jwt);
        const accessToken = await signAccessToken(jwt, { sub: user.id, username: user.username });
        set.status = 201;
        return { user_id: user.id, access_token: accessToken, refresh_token: refreshToken };
      } catch (error) {
        // unique constraint on username/email -> 409
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2002"
        ) {
          set.status = 409;
          return { error: "username_or_email_taken", message: "username or email already registered" };
        }
        return handleApiError(error, set);
      }
    })
    .post("/login", async ({ body, set }) => {
      try {
        const parsed = LoginBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid login payload" };
        }
        const user = await prisma.user.findUnique({
          where: { username: parsed.data.username },
        });
        if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
          set.status = 401;
          return { error: "invalid_credentials", message: "invalid username or password" };
        }
        const refreshToken = await issueRefreshToken(prisma, user.id, jwt);
        const accessToken = await signAccessToken(jwt, { sub: user.id, username: user.username });
        return { user_id: user.id, access_token: accessToken, refresh_token: refreshToken };
      } catch (error) {
        return handleApiError(error, set);
      }
    })
    .post("/refresh", async ({ body, set }) => {
      try {
        const parsed = RefreshBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid refresh payload" };
        }
        const rotated = await rotateRefreshToken(prisma, jwt, parsed.data.refresh_token);
        return {
          access_token: rotated.accessToken,
          refresh_token: rotated.refreshToken,
        };
      } catch (error) {
        if (error instanceof AuthError) {
          set.status = 401;
          return { error: error.kind, message: error.message };
        }
        return handleApiError(error, set);
      }
    })
    .post("/logout", async ({ body, set }) => {
      try {
        const parsed = RefreshBody.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid_request", message: "invalid logout payload" };
        }
        await revokeRefreshToken(prisma, parsed.data.refresh_token);
        return { ok: true };
      } catch (error) {
        return handleApiError(error, set);
      }
    });
}
