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

export function acquireOperationImpl(manager: PluginManager, input: { operationId: string; operationToken: string }, connectionId: string): ActiveOperation {
  const operation = manager.operations.get(input.operationId);
  const suppliedHash = hashOperationToken(input.operationToken);
  if (!operation || operation.connectionId !== connectionId || !timingSafeEqual(operation.operationTokenHash, suppliedHash)) {
    throw new Error("operation capability is invalid or expired");
  }
  if (operation.state !== "active" || performance.now() >= operation.deadline) throw new Error("operation capability is sealed or expired");
  if (operation.reverseCalls >= (manager.options.maxReverseCallsPerOperation ?? 64)) throw new Error("operation reverse call limit exceeded");
  const pluginInFlight = manager.reverseInFlightByPlugin.get(operation.pluginId) ?? 0;
  const installationInFlight = manager.reverseInFlightByInstallation.get(operation.installationId) ?? 0;
  if (
    manager.reverseInFlight >= (manager.options.maxReverseConcurrency ?? 256) ||
    pluginInFlight >= (manager.options.maxReverseConcurrencyPerPlugin ?? 64) ||
    installationInFlight >= (manager.options.maxReverseConcurrencyPerInstallation ?? 16)
  ) {
    throw new Error("reverse RPC concurrency limit exceeded");
  }
  operation.reverseCalls += 1;
  operation.inFlightReverseCalls += 1;
  manager.reverseInFlight += 1;
  manager.reverseInFlightByPlugin.set(operation.pluginId, pluginInFlight + 1);
  manager.reverseInFlightByInstallation.set(operation.installationId, installationInFlight + 1);
  return operation;
}

export function registerOperationImpl(manager: PluginManager, operationId: string, operation: ActiveOperation): void {
  const pluginCount = manager.operationsByPlugin.get(operation.pluginId) ?? 0;
  const installationCount = manager.operationsByInstallation.get(operation.installationId) ?? 0;
  if (
    manager.operations.size >= (manager.options.maxOperations ?? 256) ||
    pluginCount >= (manager.options.maxOperationsPerPlugin ?? 64) ||
    installationCount >= (manager.options.maxOperationsPerInstallation ?? 32)
  ) {
    throw Object.assign(new Error("plugin manager operation limit reached"), {
      code: "MANAGER_OVERLOADED",
      status: 503,
      publicCode: "plugin_manager_overloaded",
    });
  }
  manager.operations.set(operationId, operation);
  manager.operationsByPlugin.set(operation.pluginId, pluginCount + 1);
  manager.operationsByInstallation.set(operation.installationId, installationCount + 1);
}

export function finishOperationImpl(manager: PluginManager, operationId: string): void {
  const operation = manager.operations.get(operationId);
  if (!operation) return;
  manager.operations.delete(operationId);
  decrementCounter(manager.operationsByPlugin, operation.pluginId);
  decrementCounter(manager.operationsByInstallation, operation.installationId);
}

export function releaseOperationImpl(manager: PluginManager, operation: ActiveOperation): void {
  operation.inFlightReverseCalls -= 1;
  manager.reverseInFlight -= 1;
  decrementCounter(manager.reverseInFlightByPlugin, operation.pluginId);
  decrementCounter(manager.reverseInFlightByInstallation, operation.installationId);
  if (operation.inFlightReverseCalls === 0) {
    for (const resolve of operation.reverseSettledWaiters) resolve();
    operation.reverseSettledWaiters.clear();
  }
}

export async function sealOperationImpl(manager: PluginManager, operationId: string): Promise<void> {
  const operation = manager.operations.get(operationId);
  if (!operation) throw new Error("operation connection closed before completion");
  operation.state = "sealed";
  if (operation.inFlightReverseCalls === 0) return;
  const remaining = Math.min(250, Math.max(0, operation.deadline - performance.now()));
  if (remaining === 0) throw new Error("operation expired while reverse calls were active");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => operation.reverseSettledWaiters.add(resolve)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation reverse calls did not settle during cleanup grace")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
