import { createSigner, createVerifier } from "fast-jwt";
import type { PrismaClient } from "../db";

export interface PluginUiSessionConfig {
  secret: string;
  ttlSeconds: number;
}

export interface PluginUiSession {
  sub: string;
  projectId: string;
  installationId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  routeId: string;
  permissions: string[];
  locale: string;
  nonce: string;
}

const AUDIENCE = "soulcloud-plugin-ui";
type Signer = (payload: Record<string, unknown>) => string;
type Verifier = (token: string) => unknown;
const signers = new Map<string, Signer>();
const verifiers = new Map<string, Verifier>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function signPluginUiSession(config: PluginUiSessionConfig, session: Omit<PluginUiSession, "nonce">): string {
  const key = `${config.secret}:${config.ttlSeconds}`;
  let signer = signers.get(key);
  if (!signer) {
    signer = createSigner({ key: config.secret, algorithm: "HS256", expiresIn: config.ttlSeconds * 1000, aud: AUDIENCE });
    signers.set(key, signer);
  }
  return signer({
    sub: session.sub,
    projectId: session.projectId,
    installationId: session.installationId,
    pluginId: session.pluginId,
    pluginVersion: session.pluginVersion,
    manifestHash: session.manifestHash,
    routeId: session.routeId,
    permissions: session.permissions,
    locale: session.locale,
    nonce: crypto.randomUUID(),
  });
}

export function verifyPluginUiSession(config: PluginUiSessionConfig, token: string): PluginUiSession {
  const key = `${config.secret}:${config.ttlSeconds}`;
  let verifier = verifiers.get(key);
  if (!verifier) {
    verifier = createVerifier({ key: config.secret, algorithms: ["HS256"], allowedAud: AUDIENCE, requiredClaims: ["aud", "exp"] });
    verifiers.set(key, verifier);
  }
  const value = verifier(token) as Record<string, unknown>;
  if (
    typeof value.sub !== "string" || typeof value.projectId !== "string" ||
    typeof value.installationId !== "string" || typeof value.pluginId !== "string" ||
    typeof value.pluginVersion !== "string" || typeof value.manifestHash !== "string" ||
    typeof value.routeId !== "string" || typeof value.locale !== "string" || typeof value.nonce !== "string" ||
    !Array.isArray(value.permissions) || value.permissions.some((permission) => typeof permission !== "string")
  ) throw new Error("invalid plugin UI session");
  return {
    sub: value.sub,
    projectId: value.projectId,
    installationId: value.installationId,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    manifestHash: value.manifestHash,
    routeId: value.routeId,
    permissions: value.permissions as string[],
    locale: value.locale,
    nonce: value.nonce,
  };
}

export function pluginUiSessionCookieName(installationId: string): string {
  return `soulcloud_plugin_ui_${installationId.replaceAll("-", "")}`;
}

/**
 * Atomically consume a UI bootstrap nonce using the database as the source of
 * truth. The signed token is still verified by the caller; this function only
 * closes the replay window across restarts and multiple Manager instances.
 */
export async function consumePluginUiGrant(
  prisma: PrismaClient,
  nonce: string,
  expiresAt: Date | string,
): Promise<boolean> {
  if (!UUID.test(nonce)) throw new RangeError("plugin UI grant nonce must be a UUID");
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new RangeError("plugin UI grant expiry is invalid");
  const rows = await prisma.$queryRaw<Array<{ nonce: string }>>`
    INSERT INTO plugin_ui_grants (nonce, expires_at)
    SELECT ${nonce}::uuid, ${expiry}
    WHERE ${expiry} > CURRENT_TIMESTAMP
    ON CONFLICT (nonce) DO NOTHING
    RETURNING nonce
  `;
  return rows.length === 1;
}

/** Remove expired one-time grants in bounded batches. */
export async function purgePluginUiGrants(prisma: PrismaClient, batchSize = 256): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError("batchSize must be between 1 and 10000");
  }
  const deleted = await prisma.$executeRaw`
    WITH expired AS (
      SELECT nonce
      FROM plugin_ui_grants
      WHERE expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM plugin_ui_grants grants
    USING expired
    WHERE grants.nonce = expired.nonce
  `;
  return Number(deleted);
}
