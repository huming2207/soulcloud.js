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

export async function renderPluginUiImpl(manager: PluginManager, session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>): Promise<unknown> {
  return manager.callUi(session, "ui.render", { requestId, params });
}

export async function handlePluginUiActionImpl(manager: PluginManager, session: PluginUiSession, requestId: string, params: Record<string, string | number | boolean>, action: unknown): Promise<unknown> {
  return manager.callUi(session, "ui.handleAction", { requestId, params, action });
}

export async function encodeActionFromUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    input: { deviceId: string; actionId: string; actionInput: unknown; executionId?: string; timeoutMs?: number },): Promise<{ batchId: string; deviceCount: number }> {
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  return manager.encodeAction({
    installationId: session.installationId,
    userId: session.sub,
    deviceId: input.deviceId,
    actionId: input.actionId,
    actionInput: input.actionInput,
    executionId: input.executionId,
    humanApproved: true,
    timeoutMs: input.timeoutMs,
  });
}

export async function startDebugSessionFromUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    input: {
      deviceId: string;
      caseId: string;
      targetConfigId?: string | null;
      targetConfigRevision?: number | null;
      targetId?: string | null;
      artifactId?: string | null;
      deviceFirmwareVersion?: string | null;
      leaseMs: number;
      ttlMs: number;
      timeoutMs?: number;
    },): Promise<{ execution: DebugExecutionRecord; sessionId: string }> {
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  return manager.startDebugSession({
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
    ...input,
  });
}

export async function getPluginUiAssetImpl(manager: PluginManager, session: PluginUiSession, requestId: string, assetPath: string): Promise<unknown> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  await manager.assertUiSessionCurrent(session);
  const manifest = manager.getManifest(session.pluginId, session.pluginVersion);
  const descriptor = manifest?.ui?.assets?.find((asset) => asset.path === assetPath);
  if (!descriptor) throw Object.assign(new Error("plugin UI asset is not declared"), { status: 404 });
  const { connection } = manager.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  manager.registerOperation(operationId, {
    kind: "ui",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: session.installationId,
    projectId: session.projectId,
    pluginId: session.pluginId,
    pluginVersion: session.pluginVersion,
    userId: session.sub,
    deadline: performance.now() + 30_000,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    const result = await connection.request("ui.asset", {
      operationId,
      operationToken,
      requestId,
      assetPath,
      routeId: session.routeId,
      installationId: session.installationId,
      projectId: session.projectId,
      user: { id: session.sub, locale: session.locale, permissions: session.permissions },
    }, 30_000);
    assertRpcValueBudget(result, manager.valueBudget);
    let parsed: ReturnType<typeof uiAssetOutput.parse>;
    try {
      parsed = uiAssetOutput.parse(result);
    } catch (error) {
      throw publicError(`plugin UI asset output is invalid: ${(error as Error).message}`, 502, "plugin_ui_invalid_output");
    }
    if (parsed.contentType !== descriptor.contentType) {
      throw publicError("plugin UI asset content type differs from its manifest", 502, "plugin_ui_invalid_output");
    }
    if (await sha256BytesHex(parsed.body) !== descriptor.sha256) {
      throw publicError("plugin UI asset bytes differ from its manifest hash", 502, "plugin_ui_invalid_output");
    }
    await manager.sealOperation(operationId);
    await manager.assertUiSessionCurrent(session);
    return parsed;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function callUiImpl(manager: PluginManager, session: PluginUiSession, method: "ui.render" | "ui.handleAction", input: { requestId: string; params: Record<string, string | number | boolean>; action?: unknown }): Promise<unknown> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  try {
    assertRpcValueBudget(input, manager.valueBudget);
  } catch (error) {
    throw publicError(`plugin UI input is too large: ${(error as Error).message}`, 400, "plugin_ui_invalid_input");
  }
  await manager.assertUiSessionCurrent(session);
  const manifest = manager.getManifest(session.pluginId, session.pluginVersion);
  if (!manifest?.ui?.routes.some((route) => route.id === session.routeId)) throw new Error("plugin UI route is not declared");
  const { connection } = manager.requireConnectedManifest(session.pluginId, session.pluginVersion, session.manifestHash);
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  manager.registerOperation(operationId, {
    kind: "ui",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: session.installationId,
    projectId: session.projectId,
    pluginId: session.pluginId,
    pluginVersion: session.pluginVersion,
    userId: session.sub,
    deadline: performance.now() + 30_000,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    let result: unknown;
    try {
      result = await connection.request(method, {
        operationId,
        operationToken,
        requestId: input.requestId,
        routeId: session.routeId,
        installationId: session.installationId,
        projectId: session.projectId,
        user: { id: session.sub, locale: session.locale, permissions: session.permissions },
        params: input.params,
        ...(method === "ui.handleAction" ? { action: input.action } : {}),
      }, 30_000);
      try {
        assertRpcValueBudget(result, manager.valueBudget);
      } catch (error) {
        throw new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/INVALID_PLUGIN_OUTPUT/.test(message)) throw publicError(message, 502, "plugin_ui_invalid_output");
      throw error;
    }
    let parsed: ReturnType<typeof uiRenderOutput.parse> | ReturnType<typeof uiActionOutput.parse>;
    try {
      parsed = method === "ui.render" ? uiRenderOutput.parse(result) : uiActionOutput.parse(result);
    } catch (error) {
      throw publicError(`plugin UI output is invalid: ${(error as Error).message}`, 502, "plugin_ui_invalid_output");
    }
    await manager.sealOperation(operationId);
    // Do not return a page rendered from a snapshot that was disabled or
    // migrated while the plugin call was in flight.
    await manager.assertUiSessionCurrent(session);
    return parsed;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function assertUiSessionCurrentImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    observedInstallation?: { projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },): Promise<void> {
  const [installation, membership] = await Promise.all([
    observedInstallation ?? manager.options.prisma!.pluginInstallation.findUnique({
      where: { id: session.installationId },
      select: {
        projectId: true,
        pluginId: true,
        pluginVersion: true,
        manifestHash: true,
        state: true,
      },
    }),
    manager.options.prisma!.userProject.findUnique({
      where: { userId_projectId: { userId: session.sub, projectId: session.projectId } },
      select: { userId: true },
    }),
  ]);
  if (
    !installation ||
    !membership ||
    installation.state !== "enabled" ||
    installation.projectId !== session.projectId ||
    installation.pluginId !== session.pluginId ||
    installation.pluginVersion !== session.pluginVersion ||
    installation.manifestHash.trim() !== session.manifestHash
  ) {
    throw publicError("plugin UI session is no longer valid", 403, "plugin_ui_session_invalid");
  }
}
