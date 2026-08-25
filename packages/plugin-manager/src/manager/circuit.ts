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

export function circuitAllowsImpl(manager: PluginManager, key: string): boolean {
  const circuit = manager.circuits.get(key);
  if (!circuit) return true;
  const now = Date.now();
  if (
    circuit.probeInProgress &&
    now - (circuit.probeStartedAt ?? circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_PROBE_TIMEOUT_MS
  ) {
    circuit.probeInProgress = false;
    circuit.probeStartedAt = undefined;
  }
  if (!circuit.probeInProgress && now - (circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_IDLE_RETENTION_MS) {
    manager.circuits.delete(key);
    return true;
  }
  circuit.lastTouchedAt = now;
  if (circuit.failures < 5) return true;
  if (now - circuit.openedAt < 30_000) return false;
  if (circuit.probeInProgress) return false;
  circuit.probeInProgress = true;
  circuit.probeStartedAt = now;
  return true;
}

export function circuitFailureImpl(manager: PluginManager, key: string): void {
  const now = Date.now();
  const circuit = manager.circuits.get(key) ?? { failures: 0, openedAt: 0, probeInProgress: false, lastTouchedAt: now };
  circuit.failures += 1;
  circuit.probeInProgress = false;
  circuit.probeStartedAt = undefined;
  circuit.lastTouchedAt = now;
  if (circuit.failures >= 5) circuit.openedAt = now;
  manager.circuits.set(key, circuit);
}

export function circuitSuccessImpl(manager: PluginManager, key: string): void {
  manager.circuits.delete(key);
}

export function circuitReleaseProbeImpl(manager: PluginManager, key: string): void {
  const circuit = manager.circuits.get(key);
  if (circuit) {
    circuit.probeInProgress = false;
    circuit.probeStartedAt = undefined;
    circuit.lastTouchedAt = Date.now();
  }
}

export function pruneCircuitsImpl(manager: PluginManager, now = Date.now()): void {
  for (const [key, circuit] of manager.circuits) {
    if (
      circuit.probeInProgress &&
      now - (circuit.probeStartedAt ?? circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_PROBE_TIMEOUT_MS
    ) {
      circuit.probeInProgress = false;
      circuit.probeStartedAt = undefined;
    }
    if (!circuit.probeInProgress && now - (circuit.lastTouchedAt ?? circuit.openedAt) >= PLUGIN_CIRCUIT_IDLE_RETENTION_MS) {
      manager.circuits.delete(key);
    }
  }
}
