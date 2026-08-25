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

export function consumeEventsImpl(manager: PluginManager): void {
  if (manager.stopping || manager.eventPollRunning || !manager.options.eventStore) return;
  const running = manager.consumeEventBatch();
  manager.eventPollRunning = running;
  void running.finally(() => {
    if (manager.eventPollRunning === running) manager.eventPollRunning = null;
  });
}

export async function consumeEventBatchImpl(manager: PluginManager): Promise<void> {
  try {
    const events = await manager.options.eventStore!.lease(
      manager.options.eventBatchSize ?? 32,
      manager.options.eventLeaseMs ?? 60_000,
    );
    const pending = new Map(events.map((event) => [event.id, { id: event.id, leaseToken: event.lease_token }]));
    const leaseMs = manager.options.eventLeaseMs ?? 60_000;
    let renewal: Promise<void> | null = null;
    const renewTimer = manager.options.eventStore!.renew && pending.size > 0
      ? setInterval(() => {
          if (renewal) return;
          const leases = [...pending.values()];
          if (leases.length === 0) return;
          const running = manager.options.eventStore!.renew!(leases, leaseMs)
            .then(() => undefined)
            .catch((error) => {
              manager.log("event lease renewal failed", { count: leases.length, error: (error as Error).message });
            });
          renewal = running;
          void running.finally(() => { if (renewal === running) renewal = null; });
        }, Math.max(100, Math.floor(leaseMs / 3)))
      : null;
    renewTimer?.unref?.();
    try {
      const groups = new Map<string, LeasedPluginEvent[]>();
      for (const event of events) {
        const group = groups.get(event.installation_id);
        if (group) group.push(event);
        else groups.set(event.installation_id, [event]);
      }
      const queue = [...groups.values()];
      let nextGroup = 0;
      const consumeGroup = async (): Promise<void> => {
        while (nextGroup < queue.length) {
          const group = queue[nextGroup++]!;
          for (const event of group) {
            try {
              if (manager.stopping) await manager.releaseEvent(event, false, "plugin manager is shutting down", false);
              else await manager.dispatchEvent(event);
            } finally {
              pending.delete(event.id);
            }
          }
        }
      };
      const concurrency = Math.min(queue.length, manager.options.eventMaxConcurrency ?? 4);
      await Promise.all(Array.from({ length: concurrency }, consumeGroup));
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (renewal) await renewal;
    }
  } catch (error) {
    manager.log("event poll failed", { error: (error as Error).message });
  }
}

export async function dispatchEventImpl(manager: PluginManager, event: LeasedPluginEvent): Promise<void> {
  const store = manager.options.eventStore!;
  const circuitKey = `${event.plugin_id}\u0000${event.installation_id}`;
  if (!manager.circuitAllows(circuitKey)) {
    await manager.releaseEvent(event, false, "plugin circuit is open", false);
    return;
  }
  const connection = manager.connections.get(event.plugin_id);
  const connectedManifest = connection?.manifest;
  if (
    !connection?.isOpen ||
    connectedManifest?.pluginVersion !== event.plugin_version ||
    connectedManifest.manifestHash !== event.manifest_hash.trim()
  ) {
    manager.circuitFailure(circuitKey);
    await manager.releaseEvent(event, false, "matching plugin version is unavailable", false);
    return;
  }
  let activeOperationId: string | undefined;
  let pluginCallCompleted = false;
  try {
    const manifestEntry = manager.catalog.get(`${event.plugin_id}@${event.plugin_version}`);
    if (!manifestEntry) throw Object.assign(new Error("plugin manifest snapshot is unavailable"), { code: "MANAGER_STATE_UNAVAILABLE" });
    if (manifestEntry.manifestHash !== event.manifest_hash.trim()) {
      const error = `plugin manifest hash drift for ${event.plugin_id}@${event.plugin_version}`;
      await manager.releaseEvent(event, true, error);
      return;
    }
    const eventDescriptor = manifestEntry.manifest.events.find((item) => item.kind === event.kind && item.schemaVersion === event.schema);
    if (!eventDescriptor) {
      const error = `event ${event.kind}@${event.schema} is not declared by the plugin manifest`;
      await manager.releaseEvent(event, true, error);
      return;
    }
    const profile = manifestEntry.manifest.profiles.find((item) =>
      item.id === event.profile_id && item.version === event.profile_version,
    );
    if (!profile) {
      throw Object.assign(new Error(`persisted profile ${event.profile_id}@${event.profile_version} is not in the manifest snapshot`), {
        code: "MANAGER_DATA_CORRUPTION",
      });
    }
    const envelope = (() => {
      try {
        return decodeDeviceEvent(event.payload);
      } catch (error) {
        throw Object.assign(new Error(`persisted event payload is corrupt: ${(error as Error).message}`), { code: "MANAGER_DATA_CORRUPTION" });
      }
    })();
    try {
      assertRpcValueBudget([envelope.data, event.installation_config], manager.valueBudget);
    } catch (error) {
      throw Object.assign(new Error(`INVALID_EVENT_INPUT: ${(error as Error).message}`), { code: "INVALID_EVENT_INPUT" });
    }
    const operationId = crypto.randomUUID();
    const operationToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    manager.registerOperation(operationId, {
      kind: "event",
      operationTokenHash: hashOperationToken(operationToken),
      connectionId: connection.id,
      installationId: event.installation_id,
      projectId: event.project_id,
      pluginId: event.plugin_id,
      pluginVersion: event.plugin_version,
      manifestHash: event.manifest_hash.trim(),
      deviceId: event.device_id,
      profileId: event.profile_id,
      profileVersion: event.profile_version,
      deadline: performance.now() + (manager.options.eventTimeoutMs ?? 30_000),
      state: "active",
      reverseCalls: 0,
      inFlightReverseCalls: 0,
      stagedCommandCount: 0,
      stagedCommandBytes: 0,
      reverseSettledWaiters: new Set(),
    });
    activeOperationId = operationId;
    const execution = await manager.executionForEvent(event);
    const result = await connection.request("plugin.handleEvent", {
      operationId,
      operationToken,
      event: {
        id: event.event_id.trim(),
        seq: BigInt(event.seq),
        kind: envelope.kind,
        schema: envelope.schema,
        receivedAt: event.received_at.toISOString(),
        payload: envelope.data,
      },
      installation: {
        id: event.installation_id,
        projectId: event.project_id,
        pluginId: event.plugin_id,
        pluginVersion: event.plugin_version,
        config: event.installation_config,
      },
      device: {
        id: event.device_id,
        uid: event.device_uid,
        profileId: event.profile_id,
        profileVersion: event.profile_version,
      },
      ...(execution ? { execution } : {}),
    }, manager.options.eventTimeoutMs ?? 30_000);
    let output: ReturnType<typeof eventOutput.parse>;
    try {
      assertRpcValueBudget(result, manager.valueBudget);
      output = eventOutput.parse(result);
    } catch (error) {
      throw Object.assign(new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`), { code: "INVALID_PLUGIN_OUTPUT" });
    }
    await manager.sealOperation(operationId);
    const updates: EntityUpdateInput[] = await Promise.all((output.updates ?? []).map(async (update) => ({
      ...update,
      value: update.value instanceof Blob
        ? new Uint8Array(await update.value.arrayBuffer())
        : update.value,
    })));
    try {
      validateEntityUpdates(profile.entities, updates);
    } catch (error) {
      throw Object.assign(new Error(`INVALID_PLUGIN_OUTPUT: ${(error as Error).message}`), { code: "INVALID_PLUGIN_OUTPUT" });
    }
    pluginCallCompleted = true;
    // The breaker measures plugin/transport health, not the later database
    // commit. A responsive, valid plugin closes a half-open probe here.
    manager.circuitSuccess(circuitKey);
    for (const entry of output.logs ?? []) {
      manager.log("plugin event log", { pluginId: event.plugin_id, eventId: event.event_id.trim(), level: entry.level, message: entry.message });
    }
    if (store.completeWithUpdates) {
      const operation = activeOperationId ? manager.operations.get(activeOperationId) : undefined;
      const completed = await store.completeWithUpdates(event.id, event.lease_token, {
        installationId: event.installation_id,
        deviceId: event.device_id,
        pluginId: event.plugin_id,
        pluginVersion: event.plugin_version,
        manifestHash: event.manifest_hash.trim(),
        profileId: event.profile_id,
        profileVersion: event.profile_version,
        snapshotDescriptors: profile.entities,
        updates,
        commands: operation?.stagedCommands,
      });
      if (!completed) {
        manager.log("event completion skipped after lease loss", { eventId: event.id });
        return;
      }
    } else {
      const operation = activeOperationId ? manager.operations.get(activeOperationId) : undefined;
      if (operation?.stagedCommands?.length) throw new Error("event command intents require transactional completion");
      if (!(await store.complete(event.id, event.lease_token))) {
        manager.log("event completion skipped after lease loss", { eventId: event.id });
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    const permanent = code === "INVALID_EVENT_INPUT" || code === "INVALID_PLUGIN_OUTPUT" || code === "MANAGER_DATA_CORRUPTION" || /INVALID_(EVENT_INPUT|PLUGIN_OUTPUT)/.test(message);
    const managerDeferral = code === "MANAGER_OVERLOADED" || code === "MANAGER_STATE_UNAVAILABLE" || code === "MANAGER_DEPENDENCY_UNAVAILABLE";
    // Manager-capacity/catalog deferrals are not delivery attempts. A
    // failed database commit after a valid plugin response still needs a
    // finite retry budget, but it must not count against plugin health.
    const consumeAttempt = permanent || !managerDeferral;
    const attemptsExhausted = !permanent && consumeAttempt && event.attempt_count >= (manager.options.eventMaxAttempts ?? 5);
    if (!permanent && !pluginCallCompleted && !managerDeferral) manager.circuitFailure(circuitKey);
    else manager.circuitReleaseProbe(circuitKey);
    await manager.releaseEvent(event, permanent || attemptsExhausted, attemptsExhausted ? `${message}; retry limit exhausted` : message, consumeAttempt);
  } finally {
    // Operation capabilities are valid only while the parent RPC is live.
    if (activeOperationId) manager.finishOperation(activeOperationId);
  }
}

export async function releaseEventImpl(manager: PluginManager, event: LeasedPluginEvent, permanent: boolean, message: string, consumeAttempt = true): Promise<void> {
  const retryMs = permanent ? 0 : Math.min(60_000, 1_000 * 2 ** Math.min(event.attempt_count, 6));
  try {
    await manager.options.eventStore!.release(event.id, event.lease_token, permanent, message.slice(0, 2_000), retryMs, consumeAttempt);
  } catch (error) {
    manager.log("event lease release failed", { eventId: event.id, error: (error as Error).message });
  }
}
