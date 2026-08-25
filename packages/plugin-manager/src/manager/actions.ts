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

export async function encodeActionImpl(manager: PluginManager, input: {
    installationId: string;
    userId: string;
    deviceId: string;
    actionId: string;
    actionInput: unknown;
    executionId?: string;
    humanApproved?: boolean;
    timeoutMs?: number;
  }): Promise<{ batchId: string; deviceCount: number }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (input.executionId !== undefined && !UUID.test(input.executionId)) {
    throw publicError("debug execution ID must be a UUID", 400, "invalid_request");
  }
  if (input.executionId !== undefined && !UUID.test(input.userId)) {
    throw publicError("debug execution user ID must be a UUID", 400, "invalid_request");
  }
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw new Error("plugin installation not found");
  if (installation.state !== "enabled") throw new Error("plugin installation is disabled");
  const manifest = manager.getManifest(installation.pluginId, installation.pluginVersion);
  if (!manifest || manifest.version !== installation.pluginVersion) throw new Error("plugin manifest is unavailable");
  const action = manifest.actions.find((item) => item.id === input.actionId);
  if (!action) throw publicError("action is not declared by the plugin manifest", 404, "action_not_found");
  if (action.requiresHumanApproval && input.humanApproved !== true) {
    throw publicError("this device operation requires explicit human approval", 403, "human_approval_required");
  }
  const validInput = validateActionInput(action.inputSchema, input.actionInput);
  if (!validInput.ok) throw publicError(`invalid action input: ${validInput.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; ")}`, 400, "invalid_action_input");
  try {
    assertRpcValueBudget(input.actionInput, manager.valueBudget);
  } catch (error) {
    throw publicError(`invalid action input: ${(error as Error).message}`, 400, "invalid_action_input");
  }
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  manager.registerOperation(operationId, {
    kind: "action",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: installation.id,
    projectId: installation.projectId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    deviceId: input.deviceId,
    userId: input.userId,
    deadline: performance.now() + (input.timeoutMs ?? 30_000),
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    let encoded: { command: string; args: Array<{ name: string; value: unknown }>; schemaVersion: number };
    try {
      encoded = await connection.request("action.encode", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        deviceId: input.deviceId,
        userId: input.userId,
        actionId: input.actionId,
        input: input.actionInput,
      }, input.timeoutMs ?? 30_000) as { command: string; args: Array<{ name: string; value: unknown }>; schemaVersion: number };
      try {
        assertRpcValueBudget(encoded, manager.valueBudget);
      } catch (error) {
        throw new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`);
      }
      await manager.sealOperation(operationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/INVALID_PLUGIN_OUTPUT|plugin encoder/i.test(message)) throw publicError(`plugin encoder output invalid: ${message}`, 502, "invalid_action_output");
      throw error;
    }
    if (!encoded || encoded.command !== action.wire.command || encoded.schemaVersion !== action.wire.schemaVersion || !Array.isArray(encoded.args)) {
      throw publicError("plugin encoder output invalid: command, schemaVersion or args are malformed", 502, "invalid_action_output");
    }
    let args: CommandArgument[];
    try {
      args = await normalizeCommandArguments(encoded.args);
    } catch (error) {
      throw publicError(`plugin encoder output invalid: ${(error as Error).message}`, 502, "invalid_action_output");
    }
    let encodedInput: Record<string, unknown>;
    try {
      encodedInput = commandArgumentsToActionInput(args);
    } catch (error) {
      throw publicError(`plugin encoder output invalid: ${(error as Error).message}`, 502, "invalid_action_output");
    }
    const encodedValidation = validateActionInput(action.inputSchema, encodedInput);
    if (!encodedValidation.ok) {
      throw publicError(`plugin encoder output invalid: ${encodedValidation.failures.map((failure) => `${failure.field}: ${failure.error}`).join("; ")}`, 502, "invalid_action_output");
    }
    const batch = await manager.options.prisma.$transaction(async (tx) => {
      const installationRows = await tx.$queryRaw<Array<{ id: string; project_id: string; plugin_id: string; plugin_version: string; manifest_hash: string; state: string }>>`
        SELECT id, project_id, plugin_id, plugin_version, manifest_hash, state
        FROM plugin_installations
        WHERE id = ${installation.id}::uuid
        FOR UPDATE
      `;
      const lockedInstallation = installationRows[0];
      if (!lockedInstallation || lockedInstallation.state !== "enabled" || lockedInstallation.plugin_id !== installation.pluginId || lockedInstallation.plugin_version !== installation.pluginVersion || lockedInstallation.manifest_hash.trim() !== installation.manifestHash.trim()) {
        throw new Error("plugin installation changed while encoding action");
      }
      const deviceRows = await tx.$queryRaw<Array<{ id: string; project_id: string }>>`
        SELECT id, project_id FROM devices WHERE id = ${input.deviceId}::uuid FOR UPDATE
      `;
      const lockedDevice = deviceRows[0];
      if (!lockedDevice) throw new Error("device not found");
      if (lockedDevice.project_id !== lockedInstallation.project_id) {
        throw new Error("device and plugin installation belong to different projects");
      }
      const binding = await tx.pluginDeviceBinding.findUnique({ where: { deviceId: input.deviceId }, select: { installationId: true } });
      if (!binding || binding.installationId !== installation.id) throw new Error("device is not bound to the plugin installation");
      let executionId: string | undefined;
      if (input.executionId !== undefined) {
        const membershipRows = await tx.$queryRaw<Array<{ user_id: string }>>`
          SELECT user_id
          FROM user_projects
          WHERE user_id = ${input.userId}::uuid
            AND project_id = ${lockedInstallation.project_id}::uuid
          FOR SHARE
        `;
        if (!membershipRows[0]) throw publicError("project membership is no longer valid", 403, "forbidden");
        const executionRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM debug_executions
          WHERE id = ${input.executionId}::uuid
            AND installation_id = ${installation.id}::uuid
            AND device_id = ${input.deviceId}::uuid
            AND initiating_user_id = ${input.userId}::uuid
            AND allowed_capabilities ? 'device.enqueue_command'
            AND state = 'active'
            AND device_lease_expires_at > CURRENT_TIMESTAMP
            AND expires_at > CURRENT_TIMESTAMP
          FOR UPDATE
        `;
        if (!executionRows[0]) throw publicError("debug execution is not active for this device", 409, "conflict");
        executionId = executionRows[0].id;
      }
      return enqueueBatchInTransaction(tx, [input.deviceId], { cmd: encoded.command, args }, {
        provenance: {
          // The public Human API marks its authenticated action request as
          // explicitly approved. Preserve that distinction in platform
          // provenance; otherwise a destructive human operation is
          // indistinguishable from a plugin-origin command in the audit
          // trail. Internal callers that do not provide approval remain
          // plugin-origin commands and still require plugin provenance.
          originType: actionCommandOrigin(input.humanApproved),
          originUserId: input.userId,
          pluginInstallationId: installation.id,
          pluginVersion: installation.pluginVersion,
          manifestHash: installation.manifestHash.trim(),
          executionId,
          correlationId: operationId,
        },
      });
    });
    return { batchId: batch.id, deviceCount: batch.deviceCount };
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function configureTargetImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    userId: string;
    yaml: string;
    timeoutMs?: number;
  }): Promise<{ configId: string; revision: number; sha256: string; targetCount: number }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  manager.assertConfigurationBudget(input.yaml);
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 30_000;
  manager.registerOperation(operationId, {
    kind: "configure",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: installation.id,
    projectId: installation.projectId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    userId: input.userId,
    deadline: performance.now() + timeoutMs,
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
      result = await connection.request("debugger.configureTarget", {
        operationId,
        operationToken,
        installationId: installation.id,
        projectId: installation.projectId,
        userId: input.userId,
        yaml: input.yaml,
      }, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("INVALID_TARGET_CONFIG")) throw publicError(message, 400, "invalid_request");
      throw error;
    }
    let output: ReturnType<typeof configureTargetOutput.parse>;
    try {
      assertRpcValueBudget(result, manager.valueBudget);
      output = configureTargetOutput.parse(result);
    } catch (error) {
      throw publicError(`plugin target configuration output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
    }
    await manager.assertInstallationSnapshotCurrent(installation, "plugin installation changed while configuring target");
    return output;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function listTargetConfigsImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ configId: string; revision: number; sha256: string; targetCount: number; createdAt: string }>> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 30_000;
  manager.registerOperation(operationId, {
    kind: "configure",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: installation.id,
    projectId: installation.projectId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    userId: input.userId,
    deadline: performance.now() + timeoutMs,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    const result = await connection.request("debugger.listTargetConfigs", {
      operationId,
      operationToken,
      installationId: installation.id,
      projectId: installation.projectId,
      userId: input.userId,
    }, timeoutMs);
    let output: ReturnType<typeof listTargetConfigsOutput.parse>;
    try {
      assertRpcValueBudget(result, manager.valueBudget);
      output = listTargetConfigsOutput.parse(result);
    } catch (error) {
      throw publicError(`plugin target configuration list output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
    }
    await manager.assertInstallationSnapshotCurrent(installation, "plugin installation changed while listing target configurations");
    return output;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function listArtifactsImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    userId: string;
    timeoutMs?: number;
  }): Promise<Array<{ artifactId: string; kind: "elf" | "firmware"; filename: string; contentType: string; size: number; sha256: string; metadata: Record<string, string | number>; createdAt: string }>> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 30_000;
  manager.registerOperation(operationId, {
    kind: "configure",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: installation.id,
    projectId: installation.projectId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    userId: input.userId,
    deadline: performance.now() + timeoutMs,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    const result = await connection.request("debugger.listArtifacts", {
      operationId,
      operationToken,
      installationId: installation.id,
      projectId: installation.projectId,
      userId: input.userId,
    }, timeoutMs);
    let output: ReturnType<typeof listArtifactsOutput.parse>;
    try {
      assertRpcValueBudget(result, manager.valueBudget);
      output = listArtifactsOutput.parse(result);
    } catch (error) {
      throw publicError(`plugin artifact list output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
    }
    await manager.assertInstallationSnapshotCurrent(installation, "plugin installation changed while listing artifacts");
    return output;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function readArtifactChunkImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    userId: string;
    artifactId: string;
    offset: number;
    length: number;
    timeoutMs?: number;
  }): Promise<{ artifactId: string; offset: number; totalSize: number; sha256: string; chunk: Uint8Array; final: boolean }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 64 * 1024 * 1024) throw publicError("artifact offset is invalid", 400, "invalid_request");
  if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > 64 * 1024) throw publicError("artifact chunk length is invalid", 400, "invalid_request");
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 30_000;
  manager.registerOperation(operationId, {
    kind: "configure",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: installation.id,
    projectId: installation.projectId,
    pluginId: installation.pluginId,
    pluginVersion: installation.pluginVersion,
    userId: input.userId,
    deadline: performance.now() + timeoutMs,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    const result = await connection.request("debugger.readArtifactChunk", {
      operationId,
      operationToken,
      installationId: installation.id,
      projectId: installation.projectId,
      userId: input.userId,
      artifactId: input.artifactId,
      offset: input.offset,
      length: input.length,
    }, timeoutMs);
    let output: { artifactId: string; offset: number; totalSize: number; sha256: string; chunk: Uint8Array; final: boolean };
    try {
      assertRpcValueBudget(result, manager.valueBudget);
      const parsed = artifactReadChunkOutput.parse(result);
      const chunk = new Uint8Array(await parsed.chunk.arrayBuffer());
      if (parsed.artifactId !== input.artifactId || parsed.offset !== input.offset || chunk.byteLength > input.length || parsed.offset + chunk.byteLength > parsed.totalSize || parsed.final !== (parsed.offset + chunk.byteLength === parsed.totalSize)) {
        throw new Error("artifact chunk bounds or identity do not match the request");
      }
      output = { artifactId: parsed.artifactId, offset: parsed.offset, totalSize: parsed.totalSize, sha256: parsed.sha256, chunk, final: parsed.final };
    } catch (error) {
      throw publicError(`plugin artifact chunk output invalid: ${(error as Error).message}`, 502, "invalid_plugin_output");
    }
    await manager.assertInstallationSnapshotCurrent(installation, "plugin installation changed while reading artifact");
    return output;
  } finally {
    manager.finishOperation(operationId);
  }
}

export async function uploadArtifactImpl(manager: PluginManager, input: {
    installationId: string;
    projectId: string;
    userId: string;
    caseId?: string;
    kind: "elf" | "firmware";
    filename: string;
    contentType: string;
    uploadId: string;
    totalSize: number;
    body: ReadableStream<Uint8Array>;
    timeoutMs?: number;
    /** When present, pin this upload to the already-authenticated plugin UI snapshot. */
    uiSession?: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">;
  }): Promise<{ uploadId: string; artifactId: string; sha256: string; size: number; kind: "elf" | "firmware"; filename: string }> {
  if (!manager.options.prisma) throw new Error("plugin manager database is not configured");
  if (!Number.isSafeInteger(input.totalSize) || input.totalSize <= 0 || input.totalSize > 64 * 1024 * 1024) throw publicError("artifact size is invalid", 413, "payload_too_large");
  if (input.uiSession && (
    input.uiSession.installationId !== input.installationId ||
    input.uiSession.projectId !== input.projectId ||
    input.uiSession.sub !== input.userId
  )) {
    throw publicError("plugin UI session scope does not match the artifact upload", 403, "plugin_ui_session_invalid");
  }
  const installation = await manager.options.prisma.pluginInstallation.findUnique({
    where: { id: input.installationId },
    select: { id: true, projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (!installation) throw Object.assign(new Error("plugin installation not found"), { status: 404 });
  if (installation.projectId !== input.projectId) throw Object.assign(new Error("plugin installation project mismatch"), { status: 403 });
  if (installation.state !== "enabled") throw Object.assign(new Error("plugin installation is disabled"), { status: 409 });
  if (input.uiSession && (
    installation.pluginId !== input.uiSession.pluginId ||
    installation.pluginVersion !== input.uiSession.pluginVersion ||
    installation.manifestHash.trim().toLowerCase() !== input.uiSession.manifestHash.trim().toLowerCase()
  )) {
    throw publicError("plugin UI session is no longer valid", 403, "plugin_ui_session_invalid");
  }
  if (input.uiSession) await manager.assertUiSessionCurrent(input.uiSession, installation);
  const { connection } = manager.requireConnectedManifest(installation.pluginId, installation.pluginVersion, installation.manifestHash.trim());
  const uploadId = input.uploadId;
  const chunkTimeoutMs = input.timeoutMs ?? 30_000;
  const uploadDeadline = performance.now() + (manager.options.artifactUploadTimeoutMs ?? 600_000);
  let offset = 0;
  let bodyBytes = 0;
  let previous: Uint8Array | null = null;
  for await (const chunk of splitArtifactBody(input.body, uploadDeadline)) {
    bodyBytes += chunk.byteLength;
    if (bodyBytes > input.totalSize) throw publicError("artifact body exceeds the declared content length", 400, "invalid_request");
    if (previous) {
      const progress = await manager.sendArtifactChunk(connection, { installation, uploadId, userId: input.userId, caseId: input.caseId, kind: input.kind, filename: input.filename, contentType: input.contentType, totalSize: input.totalSize, offset, final: false, chunk: previous }, artifactChunkTimeout(chunkTimeoutMs, uploadDeadline));
      // A retry may reach an upload that already completed before the
      // previous HTTP response was delivered. The private store returns
      // the original artifact for that idempotency key; return it without
      // creating a second artifact or replaying the remaining chunks.
      if (typeof progress !== "number") {
        await manager.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
        return { uploadId, artifactId: progress.artifactId, sha256: progress.sha256, size: input.totalSize, kind: input.kind, filename: input.filename };
      }
      offset = progress;
    }
    previous = chunk;
  }
  if (!previous) throw Object.assign(new Error("artifact body is empty"), { status: 400 });
  if (bodyBytes !== input.totalSize) throw publicError("artifact body is shorter than the declared content length", 400, "invalid_request");
  await manager.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
  const result = await manager.sendArtifactChunk(connection, { installation, uploadId, userId: input.userId, caseId: input.caseId, kind: input.kind, filename: input.filename, contentType: input.contentType, totalSize: input.totalSize, offset, final: true, chunk: previous }, artifactChunkTimeout(chunkTimeoutMs, uploadDeadline), true);
  if (typeof result === "number") throw publicError("plugin did not complete artifact upload", 502, "invalid_plugin_output");
  await manager.assertArtifactInstallationSnapshotCurrent(installation, input.uiSession);
  return { uploadId, artifactId: result.artifactId, sha256: result.sha256, size: input.totalSize, kind: input.kind, filename: input.filename };
}

export async function assertArtifactInstallationSnapshotCurrentImpl(manager: PluginManager, installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string; state: string },
    uiSession?: Pick<PluginUiSession, "installationId" | "projectId" | "sub" | "pluginId" | "pluginVersion" | "manifestHash">,): Promise<void> {
  await manager.assertInstallationSnapshotCurrent(
    installation,
    uiSession ? "plugin UI session is no longer valid" : "plugin installation changed while uploading artifact",
    uiSession ? { status: 403, publicCode: "plugin_ui_session_invalid" } : undefined,
  );
  if (uiSession) await manager.assertUiSessionCurrent(uiSession, installation);
}

export async function assertInstallationSnapshotCurrentImpl(manager: PluginManager, installation: { id: string; projectId: string; pluginId: string; pluginVersion: string; manifestHash: string },
    message: string,
    options?: { status: number; publicCode: string },): Promise<void> {
  const current = await manager.options.prisma!.pluginInstallation.findUnique({
    where: { id: installation.id },
    select: { projectId: true, pluginId: true, pluginVersion: true, manifestHash: true, state: true },
  });
  if (
    !current ||
    current.projectId !== installation.projectId ||
    current.pluginId !== installation.pluginId ||
    current.pluginVersion !== installation.pluginVersion ||
    current.manifestHash.trim().toLowerCase() !== installation.manifestHash.trim().toLowerCase() ||
    current.state !== "enabled"
  ) {
    throw publicError(message, options?.status ?? 409, options?.publicCode ?? "conflict");
  }
}

export async function sendArtifactChunkImpl(manager: PluginManager, connection: PluginConnection,
    input: { installation: { id: string; projectId: string; pluginId: string; pluginVersion: string }; uploadId: string; userId: string; caseId?: string; kind: "elf" | "firmware"; filename: string; contentType: string; totalSize: number; offset: number; final: boolean; chunk: Uint8Array },
    timeoutMs: number,
    expectFinal = false,): Promise<number | { artifactId: string; sha256: string }> {
  const operationId = crypto.randomUUID();
  const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  manager.registerOperation(operationId, {
    kind: "configure",
    operationTokenHash: hashOperationToken(operationToken),
    connectionId: connection.id,
    installationId: input.installation.id,
    projectId: input.installation.projectId,
    pluginId: input.installation.pluginId,
    pluginVersion: input.installation.pluginVersion,
    userId: input.userId,
    deadline: performance.now() + timeoutMs,
    state: "active",
    reverseCalls: 0,
    inFlightReverseCalls: 0,
    stagedCommandCount: 0,
    stagedCommandBytes: 0,
    reverseSettledWaiters: new Set(),
  });
  try {
    let output: ReturnType<typeof artifactChunkOutput.parse>;
    try {
      output = artifactChunkOutput.parse(await connection.request("debugger.storeArtifactChunk", {
        operationId,
        operationToken,
        installationId: input.installation.id,
        projectId: input.installation.projectId,
        userId: input.userId,
        uploadId: input.uploadId,
        ...(input.caseId ? { caseId: input.caseId } : {}),
        kind: input.kind,
        filename: input.filename,
        contentType: input.contentType,
        totalSize: input.totalSize,
        offset: input.offset,
        final: input.final,
        chunk: input.chunk,
      }, timeoutMs));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("INVALID_ARTIFACT_INPUT")) throw publicError(message, 400, "invalid_request");
      throw error;
    }
    if (output.uploadId !== input.uploadId) {
      throw publicError("plugin returned an artifact upload ID that does not match the request", 502, "invalid_plugin_output");
    }
    if (input.final) {
      if (!output.complete || !output.artifactId || !output.sha256) throw publicError("plugin did not complete artifact upload", 502, "invalid_plugin_output");
      return { artifactId: output.artifactId, sha256: output.sha256 };
    }
    if (output.complete) {
      if (expectFinal || !output.artifactId || !output.sha256) throw publicError("plugin returned an invalid completed artifact", 502, "invalid_plugin_output");
      return { artifactId: output.artifactId, sha256: output.sha256 };
    }
    if (output.receivedBytes !== input.offset + input.chunk.byteLength) throw publicError("plugin returned an invalid artifact upload progress", 502, "invalid_plugin_output");
    return output.receivedBytes;
  } finally {
    manager.finishOperation(operationId);
  }
}
