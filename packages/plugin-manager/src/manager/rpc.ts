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

export async function reversePluginCallImpl(manager: PluginManager, input: PluginCallInput, signal: AbortSignal, connectionId: string): Promise<unknown> {
  if (signal.aborted) throw new Error("operation aborted");
  const source = manager.acquireOperation(input, connectionId);
  let targetOperationId: string | undefined;
  try {
    if (input.pluginId === source.pluginId) throw new Error("plugin-to-plugin calls cannot target the caller plugin");
    const maxDepth = manager.options.maxPluginCallDepth ?? 4;
    const depth = source.pluginCallDepth ?? 0;
    if (depth >= maxDepth) throw new Error("plugin-to-plugin call depth limit exceeded");
    assertRpcValueBudget(input.input, manager.valueBudget);
    const targetConnection = manager.connections.get(input.pluginId);
    const targetHandshake = targetConnection?.manifest;
    if (!targetConnection?.isOpen || !targetHandshake) {
      throw Object.assign(new Error("target plugin is unavailable"), { code: "MANAGER_DEPENDENCY_UNAVAILABLE" });
    }
    const targetManifest = manager.catalog.get(`${input.pluginId}@${targetHandshake.pluginVersion}`);
    if (!targetManifest || targetManifest.manifestHash !== targetHandshake.manifestHash) {
      throw Object.assign(new Error("target plugin manifest is unavailable"), { code: "MANAGER_DEPENDENCY_UNAVAILABLE" });
    }
    const remaining = Math.floor(Math.min(30_000, source.deadline - performance.now()));
    if (remaining < 1) throw new Error("operation expired");
    targetOperationId = crypto.randomUUID();
    const targetToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    manager.registerOperation(targetOperationId, {
      kind: "plugin-call",
      operationTokenHash: hashOperationToken(targetToken),
      connectionId: targetConnection.id,
      installationId: source.installationId,
      projectId: source.projectId,
      pluginId: input.pluginId,
      pluginVersion: targetHandshake.pluginVersion,
      manifestHash: targetHandshake.manifestHash,
      deviceId: source.deviceId,
      userId: source.userId,
      pluginCallDepth: depth + 1,
      deadline: performance.now() + remaining,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    const result = await targetConnection.request("plugin.call", {
      operationId: targetOperationId,
      operationToken: targetToken,
      caller: {
        pluginId: source.pluginId,
        pluginVersion: source.pluginVersion,
        projectId: source.projectId,
        installationId: source.installationId,
        ...(source.deviceId ? { deviceId: source.deviceId } : {}),
        ...(source.userId ? { userId: source.userId } : {}),
      },
      procedure: input.procedure,
      input: input.input,
    }, remaining);
    assertRpcValueBudget(result, manager.valueBudget);
    await manager.sealOperation(targetOperationId);
    return result;
  } finally {
    if (targetOperationId) manager.finishOperation(targetOperationId);
    manager.releaseOperation(source);
  }
}

export async function reverseEntityGetImpl(manager: PluginManager, input: EntityGetInput, signal: AbortSignal, connectionId: string) {
  if (signal.aborted) throw new Error("operation aborted");
  const operation = manager.acquireOperation(input, connectionId);
  try {
    if (operation.kind !== "event") throw new Error("entity read is not allowed for this operation");
    if (!operation.deviceId) throw new Error("entity read requires a device scope");
    if (!operation.profileId || operation.profileVersion === undefined || !operation.manifestHash) {
      throw new Error("entity read requires an event snapshot");
    }
    if (!manager.options.prisma) throw new Error("plugin reverse RPC is not configured");
    const state = await getPluginEntityState(manager.options.prisma, {
      installationId: operation.installationId,
      deviceId: operation.deviceId,
      pluginId: operation.pluginId,
      pluginVersion: operation.pluginVersion,
      manifestHash: operation.manifestHash,
      profileId: operation.profileId,
      profileVersion: operation.profileVersion,
    }, input.entityKey);
    if (!state) return null;
    const value = state.value instanceof Uint8Array ? new Blob([state.value]) : state.value;
    return { ...state, value };
  } finally {
    manager.releaseOperation(operation);
  }
}
