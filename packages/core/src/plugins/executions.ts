import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../db";

/** Execution states that still represent an unfinished platform capability. */
export const DEBUG_EXECUTION_NON_TERMINAL_STATES = ["active", "paused", "cancelling"] as const;
export type DebugExecutionNonTerminalState = typeof DEBUG_EXECUTION_NON_TERMINAL_STATES[number];
export type DebugExecutionTerminalState = "completed" | "failed" | "expired";
export type DebugExecutionState = DebugExecutionNonTerminalState | DebugExecutionTerminalState;

/** Safety bounds for a capability. Product case/session state remains plugin-owned. */
export const DEBUG_EXECUTION_MIN_LEASE_MS = 1_000;
export const DEBUG_EXECUTION_MAX_LEASE_MS = 15 * 60_000;
export const DEBUG_EXECUTION_MIN_TTL_MS = 2_000;
export const DEBUG_EXECUTION_MAX_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEBUG_EXECUTION_MAX_CAPABILITIES = 128;
export const DEBUG_EXECUTION_MAX_CAPABILITY_LENGTH = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface DebugExecutionRecord {
  id: string;
  installationId: string;
  deviceId: string;
  initiatingUserId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  allowedCapabilities: string[];
  state: DebugExecutionState;
  deviceLeaseExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateDebugExecutionInput {
  id?: string;
  installationId: string;
  deviceId: string;
  initiatingUserId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  allowedCapabilities: readonly string[];
  /** SHA-256 hex of the raw capability token. */
  tokenHash: string;
  leaseMs: number;
  ttlMs: number;
}

export class DebugExecutionConflictError extends Error {
  readonly code = "DEBUG_EXECUTION_CONFLICT";
  constructor(message = "device already has an active debug execution") {
    super(message);
    this.name = "DebugExecutionConflictError";
  }
}

export class DebugExecutionCapabilityError extends Error {
  readonly code = "DEBUG_EXECUTION_CAPABILITY_INVALID";
  constructor(message = "debug execution capability is invalid or expired") {
    super(message);
    this.name = "DebugExecutionCapabilityError";
  }
}

export function normalizeDebugCapabilities(capabilities: readonly string[]): string[] {
  if (!Array.isArray(capabilities) || capabilities.length > DEBUG_EXECUTION_MAX_CAPABILITIES) {
    throw new RangeError(`debug execution capabilities must contain at most ${DEBUG_EXECUTION_MAX_CAPABILITIES} items`);
  }
  const result = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || capability.length < 1 || capability.length > DEBUG_EXECUTION_MAX_CAPABILITY_LENGTH) {
      throw new RangeError("debug execution capability names must be 1..128 characters");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(capability)) {
      throw new RangeError("debug execution capability names contain invalid characters");
    }
    result.add(capability);
  }
  return [...result].sort();
}

function validateExecutionInput(input: CreateDebugExecutionInput): string[] {
  for (const [field, value] of [["id", input.id], ["installationId", input.installationId], ["deviceId", input.deviceId], ["initiatingUserId", input.initiatingUserId]] as const) {
    if (value !== undefined && !UUID.test(value)) throw new RangeError(`${field} must be a UUID`);
  }
  if (!input.pluginId || input.pluginId.length > 128) throw new RangeError("pluginId is invalid");
  if (!input.pluginVersion || input.pluginVersion.length > 128) throw new RangeError("pluginVersion is invalid");
  if (!SHA256.test(input.manifestHash) || !SHA256.test(input.tokenHash)) throw new RangeError("manifestHash and tokenHash must be lowercase SHA-256 hex");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < DEBUG_EXECUTION_MIN_LEASE_MS || input.leaseMs > DEBUG_EXECUTION_MAX_LEASE_MS) {
    throw new RangeError(`leaseMs must be between ${DEBUG_EXECUTION_MIN_LEASE_MS} and ${DEBUG_EXECUTION_MAX_LEASE_MS}`);
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < Math.max(DEBUG_EXECUTION_MIN_TTL_MS, input.leaseMs) || input.ttlMs > DEBUG_EXECUTION_MAX_TTL_MS) {
    throw new RangeError(`ttlMs must be between ${Math.max(DEBUG_EXECUTION_MIN_TTL_MS, input.leaseMs)} and ${DEBUG_EXECUTION_MAX_TTL_MS}`);
  }
  return normalizeDebugCapabilities(input.allowedCapabilities);
}

interface RawExecutionRow {
  id: string;
  installation_id: string;
  device_id: string;
  initiating_user_id: string;
  plugin_id: string;
  plugin_version: string;
  manifest_hash: string;
  allowed_capabilities: unknown;
  state: string;
  device_lease_expires_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

function asDate(value: Date | string | null): string | null {
  return value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();
}

function asCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("stored debug execution capabilities are invalid");
  }
  return value.slice() as string[];
}

function asState(value: string): DebugExecutionState {
  if ((DEBUG_EXECUTION_NON_TERMINAL_STATES as readonly string[]).includes(value) || value === "completed" || value === "failed" || value === "expired") {
    return value as DebugExecutionState;
  }
  throw new Error("stored debug execution state is invalid");
}

function mapExecution(row: RawExecutionRow): DebugExecutionRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    deviceId: row.device_id,
    initiatingUserId: row.initiating_user_id,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    manifestHash: row.manifest_hash.trim(),
    allowedCapabilities: asCapabilities(row.allowed_capabilities),
    state: asState(row.state),
    deviceLeaseExpiresAt: asDate(row.device_lease_expires_at),
    expiresAt: asDate(row.expires_at)!,
    createdAt: asDate(row.created_at)!,
    updatedAt: asDate(row.updated_at)!,
    finishedAt: asDate(row.finished_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  if (record.code === "23505" || record.code === "P2002") return true;
  const message = typeof record.message === "string" ? record.message : "";
  if (message.includes("23505") || /unique constraint/i.test(message)) return true;
  if (record.cause && record.cause !== error) return isUniqueViolation(record.cause);
  if (record.meta && typeof record.meta === "object" && record.meta !== null) {
    const meta = record.meta as { code?: unknown; message?: unknown };
    if (meta.code === "23505") return true;
    if (typeof meta.message === "string" && (meta.message.includes("23505") || /unique constraint/i.test(meta.message))) return true;
  }
  return false;
}

/**
 * Create a platform execution capability. The lock order is installation ->
 * device -> binding, matching plugin installation lifecycle operations.
 */
export async function createDebugExecution(
  prisma: PrismaClient,
  input: CreateDebugExecutionInput,
): Promise<DebugExecutionRecord> {
  const capabilities = validateExecutionInput(input);
  const id = input.id ?? randomUUID();
  return prisma.$transaction(async (tx) => {
    const installationRows = await tx.$queryRaw<Array<{ id: string; project_id: string; plugin_id: string; plugin_version: string; manifest_hash: string; state: string }>>`
      SELECT id, project_id, plugin_id, plugin_version, manifest_hash, state
      FROM plugin_installations
      WHERE id = ${input.installationId}::uuid
      FOR UPDATE
    `;
    const installation = installationRows[0];
    if (!installation) throw new Error("plugin installation not found");
    if (installation.state !== "enabled") throw new Error("plugin installation is disabled");
    if (installation.plugin_id !== input.pluginId || installation.plugin_version !== input.pluginVersion || installation.manifest_hash.trim() !== input.manifestHash) {
      throw new Error("plugin manifest snapshot does not match the installation");
    }

    const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
      SELECT id, project_id FROM devices WHERE id = ${input.deviceId}::uuid FOR UPDATE
    `;
    const device = deviceRows[0];
    if (!device) throw new Error("device not found");
    if (device.project_id !== installation.project_id) throw new Error("device and plugin installation belong to different projects");

    const bindingRows = await tx.$queryRaw<Array<{ installation_id: string }>>`
      SELECT installation_id FROM plugin_device_bindings WHERE device_id = ${input.deviceId}::uuid FOR UPDATE
    `;
    if (bindingRows[0]?.installation_id !== input.installationId) throw new Error("device is not bound to the plugin installation");
    const userProjectRows = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id
      FROM user_projects
      WHERE user_id = ${input.initiatingUserId}::uuid
        AND project_id = ${installation.project_id}::uuid
      FOR SHARE
    `;
    if (!userProjectRows[0]) throw new Error("initiating user is not a member of the project");

    try {
      const rows = await tx.$queryRaw<RawExecutionRow[]>`
        INSERT INTO debug_executions (
          id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
          manifest_hash, allowed_capabilities, token_hash, state, device_lease_expires_at, expires_at
        ) VALUES (
          ${id}::uuid, ${input.installationId}::uuid, ${input.deviceId}::uuid, ${input.initiatingUserId}::uuid,
          ${input.pluginId}, ${input.pluginVersion}, ${input.manifestHash}, ${JSON.stringify(capabilities)}::jsonb,
          ${input.tokenHash}, 'active',
          CURRENT_TIMESTAMP + (${input.leaseMs} * INTERVAL '1 millisecond'),
          CURRENT_TIMESTAMP + (${input.ttlMs} * INTERVAL '1 millisecond')
        )
        RETURNING id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
          manifest_hash, allowed_capabilities, state, device_lease_expires_at, expires_at,
          created_at, updated_at, finished_at
      `;
      if (!rows[0]) throw new Error("debug execution insert returned no row");
      return mapExecution(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DebugExecutionConflictError();
      throw error;
    }
  });
}

export async function getDebugExecution(prisma: PrismaClient, executionId: string): Promise<DebugExecutionRecord | null> {
  if (!UUID.test(executionId)) throw new RangeError("executionId must be a UUID");
  const row = await prisma.debugExecution.findUnique({ where: { id: executionId } });
  if (!row) return null;
  return mapExecution({
    id: row.id,
    installation_id: row.installationId,
    device_id: row.deviceId,
    initiating_user_id: row.initiatingUserId,
    plugin_id: row.pluginId,
    plugin_version: row.pluginVersion,
    manifest_hash: row.manifestHash,
    allowed_capabilities: row.allowedCapabilities,
    state: row.state,
    device_lease_expires_at: row.deviceLeaseExpiresAt,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    finished_at: row.finishedAt,
  });
}

export async function getDebugExecutionCapability(
  prisma: PrismaClient,
  executionId: string,
  tokenHash: string,
): Promise<DebugExecutionRecord | null> {
  if (!UUID.test(executionId) || !SHA256.test(tokenHash)) return null;
  const rows = await prisma.$queryRaw<RawExecutionRow[]>`
    SELECT e.id, e.installation_id, e.device_id, e.initiating_user_id, e.plugin_id, e.plugin_version,
      e.manifest_hash, e.allowed_capabilities, e.state, e.device_lease_expires_at, e.expires_at,
      e.created_at, e.updated_at, e.finished_at
    FROM debug_executions e
    JOIN plugin_installations i ON i.id = e.installation_id
    WHERE e.id = ${executionId}::uuid
      AND e.token_hash = ${tokenHash}
      AND e.state IN ('active', 'paused', 'cancelling')
      AND e.expires_at > CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1
        FROM user_projects up
        WHERE up.user_id = e.initiating_user_id
          AND up.project_id = i.project_id
      )
    LIMIT 1
  `;
  return rows[0] ? mapExecution(rows[0]) : null;
}

export interface DebugSessionExecutionScope {
  executionId: string;
  tokenHash: string;
  installationId: string;
  projectId: string;
  deviceId: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
}

/**
 * Re-check the execution and its lifecycle scope after a plugin session
 * bootstrap RPC. Lifecycle mutations lock installation -> device -> binding;
 * use the same order here before reading the execution so a concurrent
 * disable, migration or rebind cannot leave the caller with stale control.
 */
export async function revalidateDebugSessionExecution(
  prisma: PrismaClient,
  input: DebugSessionExecutionScope,
): Promise<DebugExecutionRecord> {
  if (
    !UUID.test(input.executionId) ||
    !UUID.test(input.installationId) ||
    !UUID.test(input.projectId) ||
    !UUID.test(input.deviceId) ||
    !SHA256.test(input.tokenHash) ||
    !SHA256.test(input.manifestHash)
  ) {
    throw new DebugExecutionCapabilityError();
  }

  return prisma.$transaction(async (tx) => {
    const installationRows = await tx.$queryRaw<Array<{
      id: string;
      project_id: string;
      plugin_id: string;
      plugin_version: string;
      manifest_hash: string;
      state: string;
    }>>`
      SELECT id, project_id, plugin_id, plugin_version, manifest_hash, state
      FROM plugin_installations
      WHERE id = ${input.installationId}::uuid
      FOR UPDATE
    `;
    const installation = installationRows[0];
    if (
      !installation ||
      installation.state !== "enabled" ||
      installation.project_id !== input.projectId ||
      installation.plugin_id !== input.pluginId ||
      installation.plugin_version !== input.pluginVersion ||
      installation.manifest_hash.trim() !== input.manifestHash
    ) {
      throw new DebugExecutionCapabilityError("debug execution scope is no longer valid");
    }

    const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
      SELECT id, project_id
      FROM devices
      WHERE id = ${input.deviceId}::uuid
      FOR UPDATE
    `;
    const device = deviceRows[0];
    if (!device || device.project_id !== input.projectId) {
      throw new DebugExecutionCapabilityError("debug execution device scope is no longer valid");
    }

    const bindingRows = await tx.$queryRaw<Array<{ installation_id: string }>>`
      SELECT installation_id
      FROM plugin_device_bindings
      WHERE device_id = ${input.deviceId}::uuid
      FOR UPDATE
    `;
    if (bindingRows[0]?.installation_id !== input.installationId) {
      throw new DebugExecutionCapabilityError("debug execution device binding is no longer valid");
    }

    const executionRows = await tx.$queryRaw<RawExecutionRow[]>`
      SELECT id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
        manifest_hash, allowed_capabilities, state, device_lease_expires_at, expires_at,
        created_at, updated_at, finished_at
      FROM debug_executions
      WHERE id = ${input.executionId}::uuid
        AND token_hash = ${input.tokenHash}
        AND installation_id = ${input.installationId}::uuid
        AND device_id = ${input.deviceId}::uuid
        AND plugin_id = ${input.pluginId}
        AND plugin_version = ${input.pluginVersion}
        AND manifest_hash = ${input.manifestHash}
        AND state = 'active'
        AND expires_at > CURRENT_TIMESTAMP
        AND device_lease_expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
    `;
    if (!executionRows[0]) throw new DebugExecutionCapabilityError();
    const userProjectRows = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id
      FROM user_projects
      WHERE user_id = ${executionRows[0].initiating_user_id}::uuid
        AND project_id = ${input.projectId}::uuid
      FOR SHARE
    `;
    if (!userProjectRows[0]) throw new DebugExecutionCapabilityError("debug execution initiating user is no longer a project member");
    return mapExecution(executionRows[0]);
  });
}

export async function renewDebugExecutionLease(
  prisma: PrismaClient,
  executionId: string,
  tokenHash: string,
  leaseMs: number,
): Promise<DebugExecutionRecord> {
  if (!UUID.test(executionId) || !SHA256.test(tokenHash)) throw new DebugExecutionCapabilityError();
  if (!Number.isSafeInteger(leaseMs) || leaseMs < DEBUG_EXECUTION_MIN_LEASE_MS || leaseMs > DEBUG_EXECUTION_MAX_LEASE_MS) throw new RangeError("leaseMs is outside the supported range");
  const rows = await prisma.$queryRaw<RawExecutionRow[]>`
    UPDATE debug_executions
    SET device_lease_expires_at = LEAST(expires_at, CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond')),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${executionId}::uuid
      AND token_hash = ${tokenHash}
      AND state = 'active'
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
      manifest_hash, allowed_capabilities, state, device_lease_expires_at, expires_at,
      created_at, updated_at, finished_at
  `;
  if (!rows[0]) throw new DebugExecutionCapabilityError();
  return mapExecution(rows[0]);
}

/** Release device control while keeping the execution paused for later inspection. */
export async function releaseDebugExecution(prisma: PrismaClient, executionId: string, tokenHash: string): Promise<DebugExecutionRecord> {
  if (!UUID.test(executionId) || !SHA256.test(tokenHash)) throw new DebugExecutionCapabilityError();
  const rows = await prisma.$queryRaw<RawExecutionRow[]>`
    UPDATE debug_executions
    SET state = 'paused', device_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${executionId}::uuid
      AND token_hash = ${tokenHash}
      AND state = 'active'
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
      manifest_hash, allowed_capabilities, state, device_lease_expires_at, expires_at,
      created_at, updated_at, finished_at
  `;
  if (!rows[0]) throw new DebugExecutionCapabilityError();
  return mapExecution(rows[0]);
}

export async function completeDebugExecution(
  prisma: PrismaClient,
  executionId: string,
  tokenHash: string,
  terminalState: "completed" | "failed",
): Promise<DebugExecutionRecord> {
  if (!UUID.test(executionId) || !SHA256.test(tokenHash)) throw new DebugExecutionCapabilityError();
  const rows = await prisma.$queryRaw<RawExecutionRow[]>`
    UPDATE debug_executions
    SET state = ${terminalState}, device_lease_expires_at = NULL,
        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${executionId}::uuid
      AND token_hash = ${tokenHash}
      AND state IN ('active', 'paused', 'cancelling')
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
      manifest_hash, allowed_capabilities, state, device_lease_expires_at, expires_at,
      created_at, updated_at, finished_at
  `;
  if (!rows[0]) throw new DebugExecutionCapabilityError();
  return mapExecution(rows[0]);
}

/** Expire stale executions and release leases without relying on application clocks. */
export async function expireDebugExecutions(prisma: PrismaClient, batchSize = 256): Promise<{ executions: number; leases: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new RangeError("batchSize must be between 1 and 10000");
  const expired = await prisma.$executeRaw`
    WITH candidates AS (
      SELECT id FROM debug_executions
      WHERE state IN ('active', 'paused', 'cancelling') AND expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE debug_executions e
    SET state = 'expired', device_lease_expires_at = NULL,
        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    FROM candidates c
    WHERE e.id = c.id
  `;
  const released = await prisma.$executeRaw`
    WITH candidates AS (
      SELECT id FROM debug_executions
      WHERE state = 'active' AND device_lease_expires_at IS NOT NULL
        AND device_lease_expires_at <= CURRENT_TIMESTAMP AND expires_at > CURRENT_TIMESTAMP
      ORDER BY device_lease_expires_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE debug_executions e
    SET state = 'paused', device_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    FROM candidates c
    WHERE e.id = c.id
  `;
  return { executions: Number(expired), leases: Number(released) };
}
