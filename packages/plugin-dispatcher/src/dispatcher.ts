/**
 * Plugin Dispatcher core (§6.3) — the trusted process that turns queued
 * plugin events into isolated plugin executions.
 *
 * This module never imports plugin worker code: it routes by manifest
 * metadata only (`pluginManifests`), and every plugin response is
 * re-validated before anything is committed.
 *
 * Loop properties:
 *   - PostgreSQL is the source of truth; LISTEN/NOTIFY (handled by the
 *     entry point) only wakes this loop earlier,
 *   - fairness: installations are visited round-robin, each with its own
 *     in-flight cap, so one project's flood cannot starve another (§6.4),
 *   - circuit breakers per installation (consecutive failures) and per
 *     plugin host (rapid crashes, inside the supervisor) bound the blast
 *     radius of a broken plugin,
 *   - failures retry with exponential backoff + jitter; permanent errors
 *     (invalid plugin output, unknown event kind) dead-letter immediately,
 *   - completion and entity updates commit in ONE transaction: an event is
 *     completed only when its side effects are durable.
 *
 * Delivery is at-least-once: a response lost after the host applied the
 * update replays the event, so plugin workers must be idempotent (SDK
 * contract).
 */

import {
  PLUGIN_EVENTS_CHANNEL,
  PluginSystemError,
  applyEntityUpdates,
  completePluginEvent,
  enqueueBatchInTransaction,
  getDeviceEntityState,
  failPluginEvent,
  leaseNextPluginEvent,
  listInstallationsWithWork,
  recoverExpiredPluginEventLeases,
  prunePluginData,
  sweepInstallationVersions,
  type PluginEventRow,
} from "@soulcloud/core";
import type { PrismaClient } from "@soulcloud/core";
import { pluginManifests } from "@soulcloud/plugins";
import {
  findEventDescriptor,
  findProfile,
  validateEventUpdates,
} from "@soulcloud/plugin-sdk";
import type { EntityUpdate, PluginManifest } from "@soulcloud/plugin-sdk";
import { DeviceCommandSchema } from "@soulcloud/core";
import { HostSupervisor, type SupervisorLogger } from "./supervisor";
import { PluginHostTimeoutError, PluginHostUnavailableError, type PluginHostClientLike } from "./rpc-client";
import type { DispatcherCoreOptions } from "./config";
import { PluginOperationRegistry, type FinishedPluginOperation, type OperationLimits } from "./operation";

// ---------------------------------------------------------------------------
// Circuit breaker (per installation)
// ---------------------------------------------------------------------------

/**
 * Timestamp-based circuit breaker. Once the cooldown elapses the circuit
 * admits traffic again WITHOUT reserving a trial slot — evaluating `open`
 * has no side effects, so idle scheduler ticks cannot stall an installation.
 * A host that is still broken re-opens the circuit after `threshold`
 * consecutive failures, bounding the post-cooldown probe window.
 */
export class InstallationCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get open(): boolean {
    return (
      this.openedAt !== null &&
      this.now() - this.openedAt < this.cooldownMs
    );
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = this.now();
      this.consecutiveFailures = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatcherStats {
  inFlight: number;
  inFlightPerInstallation: Record<string, number>;
  processed: number;
  completed: number;
  failed: number;
  deadLettered: number;
  benchedPlugins: string[];
  openCircuits: string[];
}

interface InstallationRuntime {
  id: string;
  pluginId: string;
  inFlight: number;
  breaker: InstallationCircuitBreaker;
}

export interface DispatcherDeps {
  /** Consecutive-failure threshold before an installation's circuit opens. */
  breakerThreshold?: number;
  /** How long an opened installation circuit stays open. */
  breakerCooldownMs?: number;
}

const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000;
const DEFAULT_EVENT_RETENTION_MS = 30 * 86_400_000;
const DEFAULT_ENTITY_HISTORY_RETENTION_MS = 365 * 86_400_000;

export interface DispatcherHandle {
  /** One scheduler pass (exposed for deterministic tests). */
  tick(): Promise<void>;
  wake(): void;
  stats(): DispatcherStats;
  stop(): Promise<void>;
  /** Supervised host clients, reused by the HTTP encode endpoint. */
  supervisor: HostSupervisor;
}

export function startDispatcher(
  prisma: PrismaClient,
  options: DispatcherCoreOptions,
  logger: SupervisorLogger,
  deps: DispatcherDeps = {},
): DispatcherHandle {
  const breakerThreshold = deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const breakerCooldownMs = deps.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;

  let stopped = false;
  let inFlightTotal = 0;
  let processed = 0;
  let completed = 0;
  let failed = 0;
  let deadLettered = 0;
  let rrCursor = 0;
  let sweeping = false;
  let retaining = false;
  let ticking = false;

  const installations = new Map<string, InstallationRuntime>();

  const operationLimits: OperationLimits = {
    maxOperations: options.rpcMaxOperations ?? options.maxInFlight,
    maxReverseInFlight: options.rpcMaxReverseInFlight ?? 64,
    perPluginReverseInFlight: options.rpcPerPluginReverseInFlight ?? 16,
    perInstallationReverseInFlight: options.rpcPerInstallationReverseInFlight ?? 8,
    perOperationReverseInFlight: options.rpcPerOperationReverseInFlight ?? 4,
    maxReverseCallsPerOperation: options.rpcMaxReverseCallsPerOperation ?? 64,
    maxStagedCommandsPerOperation: options.rpcMaxStagedCommandsPerOperation ?? 16,
    maxBlobsPerOperation: options.rpcMaxBlobs ?? 16,
    maxBlobBytesPerOperation: options.rpcMaxBlobBytes ?? 256 * 1024,
  };
  const operations = new PluginOperationRegistry(operationLimits, async (event, entityKey) =>
    getDeviceEntityState(prisma, {
      deviceId: event.deviceId,
      pluginId: event.pluginId,
      entityKey,
    }),
  );

  const supervisor = new HostSupervisor(
    {
      ...options,
      reverseHandlers: {
        entityGet: (input, signal) => operations.entityGet(input, signal).then((snapshot) => snapshot),
        commandEnqueue: (input, signal) => operations.commandEnqueue(input, signal),
      },
    },
    logger,
  );

  function runtimeFor(installation: {
    id: string;
    pluginId: string;
  }): InstallationRuntime {
    let runtime = installations.get(installation.id);
    if (!runtime) {
      runtime = {
        id: installation.id,
        pluginId: installation.pluginId,
        inFlight: 0,
        breaker: new InstallationCircuitBreaker(breakerThreshold, breakerCooldownMs),
      };
      installations.set(installation.id, runtime);
    }
    return runtime;
  }

  function backoffMs(attempt: number): number {
    const exponential = Math.min(
      options.backoffBaseMs * 2 ** Math.max(0, attempt - 1),
      options.backoffMaxMs,
    );
    const jitter = 1 + Math.random() * 0.25;
    return Math.round(exponential * jitter);
  }

  async function markFailed(
    event: PluginEventRow,
    error: string,
    permanent: boolean,
    runtime: InstallationRuntime,
  ): Promise<void> {
    const outcome = await failPluginEvent(prisma, {
      eventId: event.id,
      error,
      permanent,
      maxAttempts: options.maxAttempts,
      backoffMs: backoffMs(event.attemptCount),
    });
    failed += 1;
    if (outcome.state === "dead") deadLettered += 1;
    // Permanent data/routing errors cannot be repaired by retrying the host;
    // they must not pause healthy events in the same installation.
    if (!permanent) runtime.breaker.recordFailure();
    logger.warn("plugin event failed", {
      eventId: event.id,
      pluginId: event.pluginId,
      installationId: event.pluginInstallationId,
      kind: event.eventKind,
      attempt: event.attemptCount,
      outcome: outcome.state,
      permanent,
      error,
    });
  }

  async function markCompleted(
    event: PluginEventRow,
    updates: EntityUpdate[],
    runtime: InstallationRuntime,
    operation: FinishedPluginOperation | null,
  ): Promise<void> {
    const ok = await completePluginEvent(prisma, {
      eventId: event.id,
      applyUpdates: async (tx) => {
        await applyEntityUpdates(tx, {
          deviceId: event.deviceId,
          pluginId: event.pluginId,
          updates,
        });
      },
      applyCommands: async (tx) => {
        for (const staged of operation?.stagedCommands ?? []) {
          const command = DeviceCommandSchema.parse({ cmd: staged.command, args: staged.args });
          await enqueueBatchInTransaction(tx, [event.deviceId], command, {
            batchId: crypto.randomUUID(),
            deviceCount: 1,
            deliveryExpiresAt: null,
          });
        }
      },
    });
    completed += 1;
    runtime.breaker.recordSuccess();
    if (!ok) {
      logger.warn("plugin event completion raced (already terminal)", {
        eventId: event.id,
      });
    }
  }

  async function dispatchEvent(
    runtime: InstallationRuntime,
    event: PluginEventRow,
    manifest: PluginManifest,
  ): Promise<void> {
    processed += 1;
    try {
      // Routing validation: the event kind must be declared by the plugin
      // manifest for the device's profile (§5/§6.3).
      const descriptor = findEventDescriptor(
        manifest,
        event.eventKind,
        event.schemaVersion,
      );
      if (!descriptor) {
        await markFailed(
          event,
          `event kind "${event.eventKind}" v${event.schemaVersion} is not declared by plugin ${manifest.id}`,
          true,
          runtime,
        );
        return;
      }
      const profile = findProfile(
        manifest,
        event.profileId,
        event.profileVersion,
      );
      if (!profile) {
        await markFailed(
          event,
          `profile ${event.profileId} v${event.profileVersion} is not declared by plugin ${manifest.id}`,
          true,
          runtime,
        );
        return;
      }

      let client: PluginHostClientLike;
      try {
        client = await supervisor.ensureClient(
          manifest.id,
          manifest.version,
          manifest.apiVersion,
        );
      } catch (error) {
        await markFailed(
          event,
          `plugin host unavailable: ${(error as Error).message}`,
          false,
          runtime,
        );
        return;
      }

      const operation = operations.begin(event, options.eventTimeoutMs);
      let finishedOperation: FinishedPluginOperation | null = null;
      let result: unknown;
      try {
        result = await client.request(
          "plugin.handleEvent",
          {
            operationId: operation.operationId,
            operationToken: operation.token,
            eventId: event.id,
            eventKind: event.eventKind,
            schemaVersion: event.schemaVersion,
            payload: event.payload,
            device: {
              id: event.deviceId,
              deviceUid: event.deviceUid,
              profileId: event.profileId,
              profileVersion: event.profileVersion,
            },
            installation: {
              id: event.pluginInstallationId,
              projectId: event.projectId,
              config: event.installationConfig,
            },
            // This is the event's enqueue time, not dispatch/attempt time;
            // retries must present the same logical receive timestamp.
            receivedAt: event.createdAt.toISOString(),
          },
          options.eventTimeoutMs,
        );
      } catch (error) {
        operations.discard(operation.token);
        if (error instanceof PluginHostTimeoutError) {
          // A remote container cannot be cancelled by the dispatcher. Drop
          // the local client; Docker/Kubernetes health checks own restart.
          supervisor.killHost(manifest.id);
          await markFailed(
            event,
            `plugin host deadline exceeded (${options.eventTimeoutMs}ms); client invalidated`,
            false,
            runtime,
          );
          return;
        }
        if (error instanceof PluginHostUnavailableError) {
          // Do not retain a client after a transport failure; the next
          // attempt must re-handshake with the container and feed the host
          // failure circuit.
          supervisor.killHost(manifest.id);
          await markFailed(
            event,
            `plugin host connection lost: ${(error as Error).message}`,
            false,
            runtime,
          );
          return;
        }
        const coded = error as Error & { code?: string };
        if (coded.code === "invalid_params") {
          // host pre-check rejected the plugin output — deterministic
          await markFailed(
            event,
            `invalid plugin output: ${coded.message}`,
            true,
            runtime,
          );
          return;
        }
        if (coded.code === "response_too_large") {
          await markFailed(event, coded.message, true, runtime);
          return;
        }
        if (coded.code === "overloaded") {
          await markFailed(event, `plugin host overloaded`, false, runtime);
          return;
        }
        // handler_error and anything unknown: retryable — plugin bugs may
        // be data-dependent, attempts bound the damage.
        await markFailed(
          event,
          `plugin handler error: ${coded.message}`,
          false,
          runtime,
        );
        return;
      }

      finishedOperation = operations.finish(operation.token);

      // Authoritative validation of plugin output (§6.3).
      const { updates, logs } = (result ?? { updates: [] }) as {
        updates?: EntityUpdate[];
        logs?: Array<{
          level: string;
          message: string;
          fields?: Record<string, unknown>;
          pluginId?: string;
        }>;
      };
      for (const entry of logs ?? []) {
        const fields = entry.fields;
        const line = `[plugin ${entry.pluginId ?? manifest.id}] [${entry.level}] ${entry.message}`;
        if (entry.level === "error") logger.error(line, fields);
        else if (entry.level === "warn") logger.warn(line, fields);
        else logger.info(line, fields);
      }
      const check = validateEventUpdates(profile.entities, updates ?? []);
      if (!check.ok) {
        const detail = check.failures
          .slice(0, 5)
          .map((f) => `${f.entityKey}: ${f.error}`)
          .join("; ");
        await markFailed(
          event,
          `invalid plugin output — ${detail}`,
          true,
          runtime,
        );
        return;
      }
      await markCompleted(event, updates ?? [], runtime, finishedOperation);
    } catch (error) {
      logger.error("unexpected dispatch error", {
        eventId: event.id,
        error: (error as Error).message,
      });
      try {
        // The entity registry rejecting plugin output (unknown_entity /
        // invalid_entity_update) is deterministic for this event — retrying
        // would burn attempts on the same outcome (H2).
        const kind = error instanceof PluginSystemError ? error.kind : null;
        const permanent = kind === "unknown_entity" || kind === "invalid_entity_update";
        await markFailed(
          event,
          permanent
            ? `entity registry rejected plugin output (${kind}): ${(error as Error).message}`
            : `dispatcher internal error: ${(error as Error).message}`,
          permanent,
          runtime,
        );
      } catch (inner) {
        logger.error("failed to record event failure", {
          eventId: event.id,
          error: (inner as Error).message,
        });
      }
    }
  }

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const recovered = await recoverExpiredPluginEventLeases(prisma, {
        maxAttempts: options.maxAttempts,
      });
      if (recovered > 0) {
        logger.warn("recovered expired plugin event leases", { recovered });
      }
      const deployed = new Map<string, string>();
      for (const manifest of pluginManifests.values()) {
        deployed.set(manifest.id, manifest.version);
      }
      const errored = await sweepInstallationVersions(prisma, deployed);
      for (const id of errored) {
        logger.error("installation moved to error state", { installationId: id });
      }
    } catch (error) {
      logger.warn("sweep failed", { error: (error as Error).message });
    } finally {
      sweeping = false;
    }
  }

  async function retain(): Promise<void> {
    if (retaining) return;
    retaining = true;
    try {
      const result = await prunePluginData(prisma, {
        eventRetentionMs: options.eventRetentionMs ?? DEFAULT_EVENT_RETENTION_MS,
        entityHistoryRetentionMs:
          options.entityHistoryRetentionMs ?? DEFAULT_ENTITY_HISTORY_RETENTION_MS,
        batchSize: options.retentionBatchSize,
      });
      if (result.pluginEventsDeleted > 0 || result.entityHistoryDeleted > 0) {
        logger.info("plugin data retention completed", { ...result });
      }
    } catch (error) {
      logger.warn("plugin data retention failed", { error: (error as Error).message });
    } finally {
      retaining = false;
    }
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const withWork = await listInstallationsWithWork(prisma);
      if (withWork.length === 0) {
        return;
      }

      // Round-robin visit order (§6.4 fairness).
      const ordered = [
        ...withWork.slice(rrCursor),
        ...withWork.slice(0, rrCursor),
      ];
      if (withWork.length > 0) {
        rrCursor = (rrCursor + 1) % withWork.length;
      }

      for (const installation of ordered) {
        if (stopped) return;
        const manifest = pluginManifests.get(installation.pluginId);
        if (!manifest || manifest.version !== installation.configuredPluginVersion) {
          // version drift is swept to `error` periodically; never route to
          // a different version than configured (§3)
          continue;
        }
        const runtime = runtimeFor(installation);
        while (
          !stopped &&
          inFlightTotal < options.maxInFlight &&
          runtime.inFlight < options.perInstallationConcurrency &&
          !runtime.breaker.open &&
          !supervisor.isBenched(installation.pluginId)
        ) {
          const event = await leaseNextPluginEvent(prisma, {
            pluginInstallationId: installation.id,
            leaseDurationMs: options.leaseDurationMs,
          });
          if (!event) break;
          inFlightTotal += 1;
          runtime.inFlight += 1;
          void dispatchEvent(runtime, event, manifest)
            .catch((error) => {
              logger.error("dispatch crashed", {
                eventId: event.id,
                error: (error as Error).message,
              });
            })
            .finally(() => {
              inFlightTotal -= 1;
              runtime.inFlight -= 1;
            });
        }
      }
    } catch (error) {
      logger.warn("dispatcher tick failed", { error: (error as Error).message });
    } finally {
      ticking = false;
    }
  }

  const pollTimer = setInterval(() => void tick(), options.pollIntervalMs);
  const sweepTimer = setInterval(() => void sweep(), options.sweepIntervalMs);
  const retentionTimer = setInterval(
    () => void retain(),
    options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS,
  );
  pollTimer.unref?.();
  sweepTimer.unref?.();
  retentionTimer.unref?.();
  // first pass immediately; a first sweep shortly after boot
  void tick();
  const initialSweepTimer = setTimeout(() => void sweep(), 250);
  initialSweepTimer.unref?.();

  return {
    tick,
    wake() {
      void tick();
    },
    supervisor,
    stats(): DispatcherStats {
      const inFlightPerInstallation: Record<string, number> = {};
      const openCircuits: string[] = [];
      for (const runtime of installations.values()) {
        inFlightPerInstallation[runtime.id] = runtime.inFlight;
        if (runtime.breaker.open) openCircuits.push(runtime.id);
      }
      return {
        inFlight: inFlightTotal,
        inFlightPerInstallation,
        processed,
        completed,
        failed,
        deadLettered,
        benchedPlugins: supervisor.benchedPluginIds(),
        openCircuits,
      };
    },
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(sweepTimer);
      clearInterval(retentionTimer);
      clearTimeout(initialSweepTimer);
      await supervisor.stopAll();
    },
  };
}

/** LISTEN/NOTIFY wake-up channel for the dispatcher entry point. */
export { PLUGIN_EVENTS_CHANNEL };
