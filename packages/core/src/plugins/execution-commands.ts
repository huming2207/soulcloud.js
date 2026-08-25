import { type PrismaClient } from "../db";
import { enqueueBatchInTransaction } from "../queue/enqueue";
import type { DeviceCommand as WireDeviceCommand } from "../protocol/command";
import { DebugExecutionCapabilityError } from "./executions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface EnqueueDebugCommandInput {
  executionId: string;
  tokenHash: string;
  pluginId: string;
  pluginVersion: string;
  manifestHash: string;
  initiatingUserId: string;
  command: WireDeviceCommand;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface DebugCommandRecord {
  id: string;
  batchId: string;
  deviceId: string;
  sequence: bigint;
  state: DebugCommandState;
  resultCode: number | null;
  cancelRequestedAt: string | null;
  brokerAcceptedAt: string | null;
  deviceCompletedAt: string | null;
  createdAt: string;
}

export type DebugCommandState = "queued" | "leased" | "broker_accepted" | "device_completed" | "delivery_failed";

interface RawCommandRow {
  id: string;
  batch_id: string;
  device_id: string;
  sequence: bigint | number | string;
  state: string;
  result_code: number | null;
  cancel_requested_at: Date | string | null;
  broker_accepted_at: Date | string | null;
  device_completed_at: Date | string | null;
  created_at: Date | string;
}

function assertCapabilityInput(executionId: string, tokenHash: string): void {
  if (!UUID.test(executionId) || !SHA256.test(tokenHash)) throw new DebugExecutionCapabilityError();
}

function asDate(value: Date | string | null): string | null {
  return value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapCommand(row: RawCommandRow): DebugCommandRecord {
  if (row.state !== "queued" && row.state !== "leased" && row.state !== "broker_accepted" && row.state !== "device_completed" && row.state !== "delivery_failed") {
    throw new Error("stored device command state is invalid");
  }
  return {
    id: row.id,
    batchId: row.batch_id,
    deviceId: row.device_id,
    sequence: typeof row.sequence === "bigint" ? row.sequence : BigInt(row.sequence),
    state: row.state,
    resultCode: row.result_code === null ? null : Number(row.result_code),
    cancelRequestedAt: asDate(row.cancel_requested_at),
    brokerAcceptedAt: asDate(row.broker_accepted_at),
    deviceCompletedAt: asDate(row.device_completed_at),
    createdAt: asDate(row.created_at)!,
  };
}

function capabilitiesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("stored debug execution capabilities are invalid");
  return value as string[];
}

/**
 * Enqueue one non-destructive command under an execution lease. Installation,
 * device and execution rows are locked in that order before queue mutation.
 */
export async function enqueueDebugCommand(
  prisma: PrismaClient,
  input: EnqueueDebugCommandInput,
): Promise<DebugCommandRecord> {
  assertCapabilityInput(input.executionId, input.tokenHash);
  if (!UUID.test(input.initiatingUserId)) throw new RangeError("initiatingUserId must be a UUID");
  if (!UUID.test(input.correlationId ?? input.executionId)) throw new RangeError("correlationId must be a UUID");
  if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128)) throw new RangeError("idempotencyKey is invalid");

  return prisma.$transaction(async (tx) => {
    const observed = await tx.debugExecution.findUnique({ where: { id: input.executionId }, select: { installationId: true, deviceId: true } });
    if (!observed) throw new DebugExecutionCapabilityError();
    const installationRows = await tx.$queryRaw<Array<{ id: string; project_id: string; plugin_id: string; plugin_version: string; manifest_hash: string; state: string }>>`
      SELECT id, project_id, plugin_id, plugin_version, manifest_hash, state
      FROM plugin_installations WHERE id = ${observed.installationId}::uuid FOR UPDATE
    `;
    const installation = installationRows[0];
    if (!installation || installation.state !== "enabled") throw new DebugExecutionCapabilityError();
    const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
      SELECT id, project_id FROM devices WHERE id = ${observed.deviceId}::uuid FOR UPDATE
    `;
    const device = deviceRows[0];
    if (!device || device.project_id !== installation.project_id) throw new DebugExecutionCapabilityError();
    const executionRows = await tx.$queryRaw<Array<{
      id: string;
      installation_id: string;
      device_id: string;
      initiating_user_id: string;
      plugin_id: string;
      plugin_version: string;
      manifest_hash: string;
      allowed_capabilities: unknown;
      state: string;
    }>>`
      SELECT id, installation_id, device_id, initiating_user_id, plugin_id, plugin_version,
        manifest_hash, allowed_capabilities, state
      FROM debug_executions
      WHERE id = ${input.executionId}::uuid
        AND token_hash = ${input.tokenHash}
        AND state = 'active'
        AND device_lease_expires_at > CURRENT_TIMESTAMP
        AND expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
    `;
    const execution = executionRows[0];
    if (!execution || execution.installation_id !== installation.id || execution.device_id !== device.id ||
      execution.plugin_id !== input.pluginId || execution.plugin_version !== input.pluginVersion ||
      execution.manifest_hash.trim() !== input.manifestHash || execution.initiating_user_id !== input.initiatingUserId ||
      !capabilitiesOf(execution.allowed_capabilities).includes("device.enqueue_command")) {
      throw new DebugExecutionCapabilityError();
    }
    if (input.idempotencyKey) {
      const existingRows = await tx.$queryRaw<RawCommandRow[]>`
        SELECT id, batch_id, device_id, sequence, state, result_code, cancel_requested_at,
          broker_accepted_at, device_completed_at, created_at
        FROM device_commands
        WHERE execution_id = ${input.executionId}::uuid AND idempotency_key = ${input.idempotencyKey}
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
      if (existingRows[0]) return mapCommand(existingRows[0]);
    }
    const batch = await enqueueBatchInTransaction(tx, [device.id], input.command, {
      provenance: {
        originType: "plugin",
        originUserId: input.initiatingUserId,
        pluginInstallationId: installation.id,
        pluginVersion: input.pluginVersion,
        manifestHash: input.manifestHash,
        executionId: input.executionId,
        correlationId: input.correlationId ?? input.executionId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    const rows = await tx.$queryRaw<RawCommandRow[]>`
      SELECT id, batch_id, device_id, sequence, state, result_code, cancel_requested_at,
        broker_accepted_at, device_completed_at, created_at
      FROM device_commands
      WHERE batch_id = ${batch.id}::uuid AND device_id = ${device.id}::uuid
      LIMIT 1
    `;
    if (!rows[0]) throw new Error("debug command disappeared after enqueue");
    return mapCommand(rows[0]);
  });
}

export async function getDebugCommand(
  prisma: PrismaClient,
  executionId: string,
  tokenHash: string,
  commandId: string,
): Promise<DebugCommandRecord | null> {
  assertCapabilityInput(executionId, tokenHash);
  if (!UUID.test(commandId)) throw new RangeError("commandId must be a UUID");
  const rows = await prisma.$queryRaw<RawCommandRow[]>`
    SELECT c.id, c.batch_id, c.device_id, c.sequence, c.state, c.result_code,
      c.cancel_requested_at, c.broker_accepted_at, c.device_completed_at, c.created_at
    FROM device_commands c
    JOIN debug_executions e ON e.id = c.execution_id
    WHERE e.id = ${executionId}::uuid
      AND e.token_hash = ${tokenHash}
      AND e.state IN ('active', 'paused', 'cancelling')
      AND e.expires_at > CURRENT_TIMESTAMP
      AND e.allowed_capabilities ? 'device.get_command'
      AND c.id = ${commandId}::uuid
    LIMIT 1
  `;
  return rows[0] ? mapCommand(rows[0]) : null;
}

export async function requestDebugCommandCancellation(
  prisma: PrismaClient,
  executionId: string,
  tokenHash: string,
  commandId: string,
): Promise<DebugCommandRecord> {
  assertCapabilityInput(executionId, tokenHash);
  if (!UUID.test(commandId)) throw new RangeError("commandId must be a UUID");
  const capability = await prisma.$queryRaw<Array<{ allowed_capabilities: unknown }>>`
    SELECT allowed_capabilities
    FROM debug_executions
    WHERE id = ${executionId}::uuid
      AND token_hash = ${tokenHash}
      AND state IN ('active', 'paused', 'cancelling')
      AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `;
  if (!capability[0] || !capabilitiesOf(capability[0].allowed_capabilities).includes("device.cancel_command")) {
    throw new DebugExecutionCapabilityError();
  }
  const rows = await prisma.$queryRaw<RawCommandRow[]>`
    UPDATE device_commands c
    SET cancel_requested_at = COALESCE(c.cancel_requested_at, CURRENT_TIMESTAMP)
    FROM debug_executions e
    WHERE e.id = ${executionId}::uuid
      AND e.token_hash = ${tokenHash}
      AND e.state IN ('active', 'paused', 'cancelling')
      AND e.expires_at > CURRENT_TIMESTAMP
      AND e.allowed_capabilities ? 'device.cancel_command'
      AND c.execution_id = e.id
      AND c.id = ${commandId}::uuid
      AND c.state IN ('queued', 'leased', 'broker_accepted')
    RETURNING c.id, c.batch_id, c.device_id, c.sequence, c.state, c.result_code,
      c.cancel_requested_at, c.broker_accepted_at, c.device_completed_at, c.created_at
  `;
  if (rows[0]) return mapCommand(rows[0]);
  const existing = await getDebugCommand(prisma, executionId, tokenHash, commandId);
  if (!existing) throw new DebugExecutionCapabilityError("debug command is not available to this execution");
  return existing;
}
