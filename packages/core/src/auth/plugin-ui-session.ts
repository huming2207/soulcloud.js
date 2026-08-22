import { createSigner, createVerifier } from "fast-jwt";

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
}

const AUDIENCE = "soulcloud-plugin-ui";
type Signer = (payload: Record<string, unknown>) => string;
type Verifier = (token: string) => unknown;
const signers = new Map<string, Signer>();
const verifiers = new Map<string, Verifier>();

export function signPluginUiSession(config: PluginUiSessionConfig, session: PluginUiSession): string {
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
    typeof value.routeId !== "string" || typeof value.locale !== "string" ||
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
  };
}
