import { validateActionInput, validateEntityUpdates, validateManifest, type PluginManifest } from "@soulcloud/plugin-sdk";
import {
  DEFAULT_RPC_VALUE_BUDGET,
  assertRpcValueBudget,
  artifactChunkOutput,
  artifactReadChunkOutput,
  canonicalJson,
  configureTargetOutput,
  debugSessionStartOutput,
  debugSessionAbortOutput,
  eventOutput,
  listTargetConfigsOutput,
  listArtifactsOutput,
  uiAssetOutput,
  uiRenderOutput,
  uiActionOutput,
  sha256BytesHex,
  sha256Hex,
  type CommandEnqueueInput,
  type EntityGetInput,
  type ExecutionCompleteInput,
  type ExecutionGetInput,
  type ExecutionOutput,
  type ExecutionReleaseInput,
  type ExecutionRenewLeaseInput,
  type DeviceEnqueueInput,
  type DeviceGetInput,
  type DeviceCancelInput,
  type DeviceCommandOutput,
  type HandshakeOutput,
  type PluginCallInput,
  type RpcValueBudget,
} from "@soulcloud/plugin-rpc-contract";
import {
  completePluginEvent,
  completePluginEventWithUpdates,
  decodeDeviceEvent,
  enqueueBatchInTransaction,
  getPluginEntityState,
  bindDeviceToPluginInstallation,
  completeDebugExecution,
  createPluginInstallation,
  createDebugExecution,
  enqueueDebugCommand,
  expireDebugExecutions,
  getDebugExecutionCapability,
  revalidateDebugSessionExecution,
  getDebugCommand,
  listDebugCommands,
  getDebugExecution,
  consumePluginUiGrant,
  purgePluginUiGrants,
  migratePluginInstallation,
  reconcilePluginInstallation,
  releaseDebugExecution,
  releaseDebugExecutionForUser,
  renewDebugExecutionLeaseForUser,
  requestDebugCommandCancellation,
  renewDebugExecutionLease,
  setPluginInstallationState,
  leasePluginEvents,
  releasePluginEvent,
  renewPluginEventLeases,
  purgePluginData,
  Prisma,
  type LeasedPluginEvent,
  type EntityUpdateInput,
  type EntityDescriptorInput,
  type CommandArgument,
  type DeviceCommand,
  type DebugExecutionRecord,
  type PluginUiSession,
  type BindDeviceInput,
  type CreateInstallationInput,
  type PrismaClient,
  DebugExecutionCapabilityError,
} from "@soulcloud/core";
import { PluginConnection, type PluginConnectionOptions, type ReverseHandlers } from "../connection";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PluginManager } from "../manager";
import {
  ActiveOperation,
  CachedExecutionCapability,
  DEBUG_SESSION_CAPABILITIES,
  PLUGIN_CIRCUIT_IDLE_RETENTION_MS,
  PLUGIN_CIRCUIT_PROBE_TIMEOUT_MS,
  PluginCircuit,
  UUID,
  actionCommandOrigin,
  artifactChunkTimeout,
  commandArgumentsToActionInput,
  commandIntentBytes,
  decrementCounter,
  executionScopeKey,
  hashCapabilityToken,
  hashOperationToken,
  normalizeCommandArguments,
  publicError,
  readArtifactChunk,
  splitArtifactBody,
  unavailable,
} from "./helpers";

export function cacheExecutionCapabilityImpl(manager: PluginManager, execution: DebugExecutionRecord, token: string): void {
  const expiresAt = Date.parse(execution.expiresAt);
  if (!Number.isFinite(expiresAt)) return;
  const previous = manager.executionByDevice.get(executionScopeKey(execution.installationId, execution.deviceId));
  if (previous && previous !== execution.id) manager.executionTokens.delete(previous);
  manager.executionTokens.set(execution.id, {
    installationId: execution.installationId,
    deviceId: execution.deviceId,
    token,
    expiresAt,
  });
  manager.executionByDevice.set(executionScopeKey(execution.installationId, execution.deviceId), execution.id);
}

export function forgetExecutionDeviceScopeImpl(manager: PluginManager, executionId: string): void {
  const cached = manager.executionTokens.get(executionId);
  if (!cached) return;
  const key = executionScopeKey(cached.installationId, cached.deviceId);
  if (manager.executionByDevice.get(key) === executionId) manager.executionByDevice.delete(key);
}

export function forgetExecutionCapabilityImpl(manager: PluginManager, executionId: string): void {
  manager.forgetExecutionDeviceScope(executionId);
  manager.executionTokens.delete(executionId);
}

export function pruneExecutionCapabilitiesImpl(manager: PluginManager): void {
  const now = Date.now();
  for (const [executionId, cached] of manager.executionTokens) {
    if (cached.expiresAt <= now) manager.forgetExecutionCapability(executionId);
  }
}

export async function executionForEventImpl(manager: PluginManager, event: LeasedPluginEvent): Promise<{ executionId: string; executionToken: string } | null> {
  if (!manager.options.prisma) return null;
  const executionId = manager.executionByDevice.get(executionScopeKey(event.installation_id, event.device_id));
  if (!executionId) return null;
  const cached = manager.executionTokens.get(executionId);
  if (!cached || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(executionId);
    return null;
  }
  const execution = await getDebugExecutionCapability(manager.options.prisma, executionId, hashCapabilityToken(cached.token));
  if (
    !execution ||
    execution.state !== "active" ||
    !execution.deviceLeaseExpiresAt ||
    Date.parse(execution.deviceLeaseExpiresAt) <= Date.now() ||
    execution.installationId !== event.installation_id ||
    execution.deviceId !== event.device_id ||
    execution.pluginId !== event.plugin_id ||
    execution.pluginVersion !== event.plugin_version ||
    execution.manifestHash !== event.manifest_hash.trim()
  ) {
    manager.forgetExecutionCapability(executionId);
    return null;
  }
  return { executionId, executionToken: cached.token };
}

export async function executionForOperationImpl(manager: PluginManager, input: { executionId: string; executionToken: string },
    operation: ActiveOperation,
    capability: string,): Promise<{ execution: DebugExecutionRecord; tokenHash: string }> {
  if (!manager.options.prisma) throw new Error("plugin execution RPC is not configured");
  const tokenHash = hashCapabilityToken(input.executionToken);
  const execution = await getDebugExecutionCapability(manager.options.prisma, input.executionId, tokenHash);
  if (!execution ||
    execution.installationId !== operation.installationId ||
    execution.pluginId !== operation.pluginId ||
    execution.pluginVersion !== operation.pluginVersion ||
    execution.manifestHash.trim() !== operation.manifestHash ||
    (operation.deviceId !== undefined && execution.deviceId !== operation.deviceId)) {
    throw new Error("debug execution capability is outside the operation scope");
  }
  if (!execution.allowedCapabilities.includes(capability)) {
    throw new Error(`debug execution capability ${capability} is not granted`);
  }
  return { execution, tokenHash };
}

export async function reverseExecutionGetImpl(manager: PluginManager, input: ExecutionGetInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    return (await manager.executionForOperation(input, operation, "execution.get")).execution;
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseExecutionRenewLeaseImpl(manager: PluginManager, input: ExecutionRenewLeaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "execution.renew_lease");
    return renewDebugExecutionLease(manager.options.prisma!, execution.id, tokenHash, input.leaseMs);
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseExecutionReleaseImpl(manager: PluginManager, input: ExecutionReleaseInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "execution.release");
    const result = await releaseDebugExecution(manager.options.prisma!, execution.id, tokenHash);
    manager.forgetExecutionDeviceScope(execution.id);
    return result;
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseExecutionCompleteImpl(manager: PluginManager, input: ExecutionCompleteInput, signal: AbortSignal, connectionId: string): Promise<ExecutionOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "execution.complete");
    const result = await completeDebugExecution(manager.options.prisma!, execution.id, tokenHash, input.state);
    manager.forgetExecutionCapability(execution.id);
    return result;
  } finally {
    manager.releaseOperation(operation);
  }
}

export function assertExecutionCommandAllowedImpl(manager: PluginManager, operation: ActiveOperation, command: string, args: readonly CommandArgument[]): void {
  const invalidCode = operation.kind === "event" ? "INVALID_EVENT_INPUT" : "INVALID_EXECUTION_INPUT";
  const manifest = manager.getManifest(operation.pluginId, operation.pluginVersion);
  const actions = manifest?.actions.filter((action) => action.wire.command === command) ?? [];
  if (actions.length === 0) {
    throw Object.assign(new Error(`execution command ${command} is not declared by the plugin manifest`), { code: invalidCode });
  }
  if (actions.some((action) => action.requiresHumanApproval)) {
    throw Object.assign(new Error(`execution command ${command} requires human approval`), { code: invalidCode });
  }
  let actionInput: Record<string, unknown>;
  try {
    actionInput = commandArgumentsToActionInput(args);
  } catch (error) {
    throw Object.assign(new Error(`execution command ${command} arguments are malformed: ${(error as Error).message}`), { code: invalidCode });
  }
  if (!actions.some((action) => validateActionInput(action.inputSchema, actionInput).ok)) {
    throw Object.assign(new Error(`execution command ${command} arguments do not match the plugin action schema`), { code: invalidCode });
  }
}

export async function reverseDeviceEnqueueImpl(manager: PluginManager, input: DeviceEnqueueInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    if (!manager.options.prisma) throw new Error("plugin device RPC is not configured");
    assertRpcValueBudget(input.args, manager.valueBudget);
    const args = await normalizeCommandArguments(input.args);
    manager.assertExecutionCommandAllowed(operation, input.command, args);
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "device.enqueue_command");
    return await enqueueDebugCommand(manager.options.prisma, {
      executionId: execution.id,
      tokenHash,
      pluginId: operation.pluginId,
      pluginVersion: operation.pluginVersion,
      manifestHash: execution.manifestHash,
      initiatingUserId: execution.initiatingUserId,
      command: { cmd: input.command, args },
      correlationId: execution.id,
      idempotencyKey: input.idempotencyKey,
    });
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseDeviceGetImpl(manager: PluginManager, input: DeviceGetInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput | null> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    if (!manager.options.prisma) throw new Error("plugin device RPC is not configured");
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "device.get_command");
    return getDebugCommand(manager.options.prisma, execution.id, tokenHash, input.commandId);
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseDeviceCancelImpl(manager: PluginManager, input: DeviceCancelInput, signal: AbortSignal, connectionId: string): Promise<DeviceCommandOutput> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    if (!manager.options.prisma) throw new Error("plugin device RPC is not configured");
    const { execution, tokenHash } = await manager.executionForOperation(input, operation, "device.cancel_command");
    return requestDebugCommandCancellation(manager.options.prisma, execution.id, tokenHash, input.commandId);
  } finally {
    manager.releaseOperation(operation);
  }
}

export async function reverseCommandEnqueueImpl(manager: PluginManager, input: CommandEnqueueInput, signal: AbortSignal, connectionId: string): Promise<{ accepted: true }> {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  let reservation = 0;
  let reserved = false;
  try {
    if (operation.kind !== "event") throw new Error("command enqueue is not allowed for this operation");
    if (!operation.deviceId) throw new Error("command enqueue requires a device scope");
    if (!manager.options.prisma) throw new Error("plugin reverse RPC is not configured");
    assertRpcValueBudget(input.args, manager.valueBudget);
    const args = await normalizeCommandArguments(input.args);
    reservation = commandIntentBytes(input.command, input.args);
    if (operation.stagedCommandCount >= (manager.options.maxStagedCommands ?? 32)) {
      throw new Error("operation command intent limit exceeded");
    }
    if (operation.stagedCommandBytes + reservation > (manager.options.maxStagedCommandBytes ?? 256 * 1024)) {
      throw new Error("operation command intent byte limit exceeded");
    }
    manager.assertExecutionCommandAllowed(operation, input.command, args);
    operation.stagedCommandCount += 1;
    operation.stagedCommandBytes += reservation;
    reserved = true;
    const binding = await manager.options.prisma.pluginDeviceBinding.findUnique({
      where: { deviceId: operation.deviceId },
      select: { installationId: true, installation: { select: { state: true, projectId: true } } },
    });
    if (!binding || binding.installationId !== operation.installationId || binding.installation.projectId !== operation.projectId || binding.installation.state !== "enabled") {
      throw new Error("device is not bound to the active plugin installation");
    }
    operation.stagedCommands ??= [];
    operation.stagedCommands.push({ deviceId: operation.deviceId, command: { cmd: input.command, args } });
    return { accepted: true };
  } catch (error) {
    if (reserved) {
      operation.stagedCommandCount -= 1;
      operation.stagedCommandBytes -= reservation;
    }
    throw error;
  } finally {
    manager.releaseOperation(operation);
  }
}
