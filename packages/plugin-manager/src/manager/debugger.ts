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

export async function startDebugExecutionImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    deviceId: string;
    userId: string;
    allowedCapabilities: readonly string[];
    leaseMs: number;
    ttlMs: number;
  }): Promise<{ execution: DebugExecutionRecord; executionToken: string }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const executionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const execution = await createDebugExecution(manager.options.prisma, {
    installationId: installation.id,
    deviceId: input.deviceId,
    initiatingUserId: input.userId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    manifestHash: installation.manifestHash.trim(),
    allowedCapabilities: input.allowedCapabilities,
    tokenHash: hashCapabilityToken(executionToken),
    leaseMs: input.leaseMs,
    ttlMs: input.ttlMs,
  });
  manager.cacheExecutionCapability(execution, executionToken);
  return { execution, executionToken };
}

export async function startDebugSessionImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    deviceId: string;
    userId: string;
    caseId: string;
    targetConfigId?: string | null;
    targetConfigRevision?: number | null;
    targetId?: string | null;
    artifactId?: string | null;
    deviceFirmwareVersion?: string | null;
    leaseMs: number;
    ttlMs: number;
    timeoutMs?: number;
  }): Promise<{ execution: DebugExecutionRecord; sessionId: string }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  let started: { execution: DebugExecutionRecord; executionToken: string } | undefined;
  let operationId: string | undefined;
  let bootstrapSessionId: string | undefined;
  let bootstrapConnection: PluginConnection | undefined;
  let bootstrapInstallation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string } | undefined;
  try {
    started = await manager.startDebugExecution({
      installationId: input.installationId,
      projectId: input.projectId,
      deviceId: input.deviceId,
      userId: input.userId,
      allowedCapabilities: DEBUG_SESSION_CAPABILITIES,
      leaseMs: input.leaseMs,
      ttlMs: input.ttlMs,
    });
    const execution = started.execution;
    const installation = await manager.options.prisma.pluginInstallation.findUnique({
      where: { id: input.installationId },
      select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
    });
    if (!installation || installation.state !== "enabled" || installation.projectId !== input.projectId) throw new Error("plugin installation changed while starting debug session");
    const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
    bootstrapConnection = connection;
    bootstrapInstallation = { ...installation, manifestHash: installation.manifestHash.trim() };
    operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const timeoutMs = input.timeoutMs ?? 30_000;
    manager.registerOperation(operationId, {
      kind: "debug-session-bootstrap",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: installation.id,
      projectId: installation.projectId,
      pluginId: installation.pluginId,
      pluginVersion: installation.pluginVersion,
      manifestHash: installation.manifestHash.trim(),
      deviceId: input.deviceId,
      userId: input.userId,
      deadline: performance.now() + timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    const output = await connection.request("debugger.startSession", {
      operationId,
      operationToken,
      installationId: installation.id,
      projectId: installation.projectId,
      deviceId: input.deviceId,
      userId: input.userId,
      pluginVersion: installation.pluginVersion,
      manifestHash: installation.manifestHash.trim(),
      executionId: execution.id,
      executionToken: started.executionToken,
      caseId: input.caseId,
      ...(input.targetConfigId !== undefined ? { targetConfigId: input.targetConfigId } : {}),
      ...(input.targetConfigRevision !== undefined ? { targetConfigRevision: input.targetConfigRevision } : {}),
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      ...(input.deviceFirmwareVersion !== undefined ? { deviceFirmwareVersion: input.deviceFirmwareVersion } : {}),
    }, timeoutMs);
    const parsed = debugSessionStartOutput.parse(output);
    bootstrapSessionId = parsed.sessionId;
    // Record the private session before validating the echoed execution ID.
    // A buggy plugin can create a session successfully and then return a
    // malformed envelope; cleanup must still be able to mark that session
    // failed using the platform execution scope.
    if (parsed.executionId !== execution.id) throw new Error("plugin returned a different debug execution id");
    await manager.sealOperation(operationId);
    let currentExecution: DebugExecutionRecord;
    try {
      currentExecution = await revalidateDebugSessionExecution(manager.options.prisma, {
        executionId: execution.id,
        tokenHash: hashCapabilityToken(started.executionToken),
        installationId: installation.id,
        projectId: installation.projectId,
        deviceId: input.deviceId,
        pluginId: installation.pluginId,
        pluginVersion: installation.pluginVersion,
        manifestHash: installation.manifestHash.trim(),
      });
    } catch (error) {
      if (error instanceof DebugExecutionCapabilityError) {
        throw publicError("debug execution changed while starting debug session", 409, "conflict");
      }
      throw error;
    }
    return { execution: currentExecution, sessionId: parsed.sessionId };
  } catch (error) {
    if (bootstrapConnection && bootstrapInstallation && started) {
      await manager.abortDebugSessionBestEffort({
        connection: bootstrapConnection,
        installation: bootstrapInstallation,
        deviceId: input.deviceId,
        executionId: started.execution.id,
        sessionId: bootstrapSessionId,
        userId: input.userId,
        reason: "debug session bootstrap did not complete successfully",
        timeoutMs: Math.min(input.timeoutMs ?? 30_000, 5_000),
      });
    }
    if (started) {
      await completeDebugExecution(manager.options.prisma, started.execution.id, hashCapabilityToken(started.executionToken), "failed").catch(() => undefined);
      manager.forgetExecutionCapability(started.execution.id);
    }
    throw error;
  } finally {
    if (operationId) manager.finishOperation(operationId);
  }
}

export async function abortDebugSessionBestEffortImpl(manager: PluginManager, input: {
    connection: PluginConnection;
    installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string };
    deviceId: string;
    executionId: string;
    sessionId?: string;
    userId: string;
    reason: string;
    timeoutMs: number;
  }): Promise<void> {
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  try {
    manager.registerOperation(operationId, {
      kind: "debug-session-bootstrap",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: input.connection.id,
      installationId: input.installation.id,
      projectId: input.installation.projectId,
      pluginId: input.installation.pluginId,
      pluginVersion: input.installation.pluginVersion,
      manifestHash: input.installation.manifestHash,
      deviceId: input.deviceId,
      userId: input.userId,
      deadline: performance.now() + input.timeoutMs,
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    const output = await input.connection.request("debugger.abortSession", {
      operationId,
      operationToken,
      installationId: input.installation.id,
      projectId: input.installation.projectId,
      deviceId: input.deviceId,
      executionId: input.executionId,
      sessionId: input.sessionId ?? null,
      reason: input.reason,
    }, input.timeoutMs);
    const parsed = debugSessionAbortOutput.parse(output);
    if (
      parsed.executionId !== input.executionId ||
      (input.sessionId !== undefined && input.sessionId !== null && parsed.sessionId !== input.sessionId)
    ) {
      throw new Error("plugin returned an invalid debug session cleanup output");
    }
    await manager.sealOperation(operationId);
  } catch (error) {
    manager.log("debug session cleanup failed", { sessionId: input.sessionId, executionId: input.executionId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function getDebugExecutionImpl(manager: PluginManager, executionId: string): Promise<DebugExecutionRecord | null> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  return getDebugExecution(manager.options.prisma, executionId);
}

export async function getDebugExecutionForScopeImpl(manager: PluginManager, input: { executionId: string; installationId: string; projectId: string; userId: string }): Promise<DebugExecutionRecord | null> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(input.userId)) return null;
  const [execution, installation, membership] = await Promise.all([
    getDebugExecution(manager.options.prisma, input.executionId),
    manager.options.prisma.pluginInstallation.findUnique({ where: { id: input.installationId }, select: { projectId: true } }),
    manager.options.prisma.userProject.findUnique({ where: { userId_projectId: { userId: input.userId, projectId: input.projectId } }, select: { userId: true } }),
  ]);
  if (!execution || execution.installationId !== input.installationId) return null;
  if (!installation || installation.projectId !== input.projectId || !membership) return null;
  return execution;
}

export async function listDebugCommandsForUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,): Promise<ReturnType<typeof listDebugCommands>> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  const execution = await manager.getDebugExecutionForScope({ executionId, installationId: session.installationId, projectId: session.projectId, userId: session.sub });
  if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
    throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
  }
  return listDebugCommands(manager.options.prisma, executionId, 64);
}

export async function getDebugExecutionForUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  const execution = await manager.getDebugExecutionForScope({
    executionId,
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
  });
  if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
    throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
  }
  return execution;
}

export async function cancelDebugCommandFromUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    commandId: string,): Promise<ReturnType<typeof requestDebugCommandCancellation>> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(executionId) || !UUID.test(commandId)) throw publicError("debug execution or command ID must be a UUID", 400, "invalid_request");
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  const execution = await manager.getDebugExecutionForScope({
    executionId,
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
  });
  if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
    throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
  }
  if (execution.initiatingUserId !== session.sub) {
    throw publicError("only the execution initiating user can cancel its commands", 403, "forbidden");
  }
  const cached = manager.executionTokens.get(execution.id);
  if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(execution.id);
    throw publicError("debug execution capability is no longer available", 409, "conflict");
  }
  return requestDebugCommandCancellation(manager.options.prisma, execution.id, hashCapabilityToken(cached.token), commandId);
}

export async function cancelDebugCommandForUserImpl(manager: PluginManager, input: {
    executionId: string;
    commandId: string;
    installationId: string;
    projectId: string;
    userId: string;
  }): Promise<ReturnType<typeof requestDebugCommandCancellation>> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(input.executionId) || !UUID.test(input.commandId) || !UUID.test(input.installationId) || !UUID.test(input.projectId) || !UUID.test(input.userId)) {
    throw publicError("debug command scope must contain UUIDs", 400, "invalid_request");
  }
  const execution = await manager.getDebugExecutionForScope({
    executionId: input.executionId,
    installationId: input.installationId,
    projectId: input.projectId,
    userId: input.userId,
  });
  if (!execution) throw publicError("debug execution is not available to this user", 404, "not_found");
  if (execution.initiatingUserId !== input.userId) {
    throw publicError("only the execution initiating user can cancel its commands", 403, "forbidden");
  }
  const cached = manager.executionTokens.get(execution.id);
  if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(execution.id);
    throw publicError("debug execution capability is no longer available", 409, "conflict");
  }
  return requestDebugCommandCancellation(manager.options.prisma, execution.id, hashCapabilityToken(cached.token), input.commandId);
}

export async function releaseDebugExecutionFromUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  const execution = await manager.getDebugExecutionForScope({
    executionId,
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
  });
  if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
    throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
  }
  if (execution.initiatingUserId !== session.sub) {
    throw publicError("only the execution initiating user can release this lease", 403, "forbidden");
  }
  const cached = manager.executionTokens.get(execution.id);
  if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(execution.id);
    throw publicError("debug execution capability is no longer available", 409, "conflict");
  }
  const released = await releaseDebugExecutionForUser(manager.options.prisma, {
    executionId: execution.id,
    tokenHash: hashCapabilityToken(cached.token),
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
  });
  manager.forgetExecutionDeviceScope(execution.id);
  return released;
}

export async function pauseDebugExecutionForUserImpl(manager: PluginManager, input: {
    executionId: string;
    installationId: string;
    projectId: string;
    userId: string;
  }): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(input.executionId) || !UUID.test(input.installationId) || !UUID.test(input.projectId) || !UUID.test(input.userId)) {
    throw publicError("debug execution scope must contain UUIDs", 400, "invalid_request");
  }
  const execution = await manager.getDebugExecutionForScope(input);
  if (!execution) throw publicError("debug execution is not available to this user", 404, "not_found");
  if (execution.initiatingUserId !== input.userId) {
    throw publicError("only the execution initiating user can pause this execution", 403, "forbidden");
  }
  const cached = manager.executionTokens.get(execution.id);
  if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(execution.id);
    throw publicError("debug execution capability is no longer available", 409, "conflict");
  }
  const paused = await releaseDebugExecutionForUser(manager.options.prisma, {
    executionId: execution.id,
    tokenHash: hashCapabilityToken(cached.token),
    installationId: input.installationId,
    projectId: input.projectId,
    userId: input.userId,
  });
  manager.forgetExecutionDeviceScope(execution.id);
  return paused;
}

export async function renewDebugExecutionFromUiSessionImpl(manager: PluginManager, session: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,
    executionId: string,
    leaseMs: number,): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!UUID.test(executionId)) throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) throw publicError("debug execution lease is invalid", 400, "invalid_request");
  await manager.assertUiSessionCurrent(session as PluginUiSession);
  const execution = await manager.getDebugExecutionForScope({
    executionId,
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
  });
  if (!execution || execution.pluginId !== session.pluginId || execution.pluginVersion !== session.pluginVersion || execution.manifestHash !== session.manifestHash) {
    throw publicError("debug execution is not available to this plugin UI session", 404, "not_found");
  }
  if (execution.initiatingUserId !== session.sub) {
    throw publicError("only the execution initiating user can renew this lease", 403, "forbidden");
  }
  const cached = manager.executionTokens.get(execution.id);
  if (!cached || cached.installationId !== execution.installationId || cached.deviceId !== execution.deviceId || cached.expiresAt <= Date.now()) {
    manager.forgetExecutionCapability(execution.id);
    throw publicError("debug execution capability is no longer available", 409, "conflict");
  }
  return renewDebugExecutionLeaseForUser(manager.options.prisma, {
    executionId: execution.id,
    tokenHash: hashCapabilityToken(cached.token),
    installationId: session.installationId,
    projectId: session.projectId,
    userId: session.sub,
    leaseMs,
  });
}

export async function renewDebugExecutionImpl(manager: PluginManager, executionId: string, executionToken: string, leaseMs: number): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  return renewDebugExecutionLease(manager.options.prisma, executionId, hashCapabilityToken(executionToken), leaseMs);
}

export async function releaseDebugExecutionImpl(manager: PluginManager, executionId: string, executionToken: string): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  const result = await releaseDebugExecution(manager.options.prisma, executionId, hashCapabilityToken(executionToken));
  manager.forgetExecutionDeviceScope(executionId);
  return result;
}

export async function completeDebugExecutionImpl(manager: PluginManager, executionId: string, executionToken: string, state: "completed" | "failed"): Promise<DebugExecutionRecord> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  const result = await completeDebugExecution(manager.options.prisma, executionId, hashCapabilityToken(executionToken), state);
  manager.forgetExecutionCapability(executionId);
  return result;
}

export async function setInstallationStateImpl(manager: PluginManager, installationId: string, state: "enabled" | "disabled"): Promise<void> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (state === "enabled") {
    const installation = await manager.options.prisma.pluginInstallation.findUnique({
      where: { id: installationId },
      select: { pluginId: true, pluginVersion: true, manifestHash: true },
    });
    if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
    manager.requireConnectedManifest(
      installation.pluginId,
      installation.pluginVersion,
      installation.manifestHash.trim(),
    );
  }
  return setPluginInstallationState(manager.options.prisma, installationId, state);
}

export async function migrateInstallationImpl(manager: PluginManager, installationId: string, pluginVersion: string, manifestHash: string, config: unknown): Promise<void> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  manager.assertConfigurationBudget(config);
  const installation = await manager.options.prisma.pluginInstallation.findUnique({ where: { id: installationId }, select: { pluginId: true } });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  manager.requireConnectedManifest(installation.pluginId, pluginVersion, manifestHash);
  return migratePluginInstallation(manager.options.prisma, installationId, pluginVersion, manifestHash, config);
}

export async function reconcileInstallationImpl(manager: PluginManager, installationId: string): Promise<void> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  return reconcilePluginInstallation(manager.options.prisma, installationId);
}
