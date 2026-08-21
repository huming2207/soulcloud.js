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
  applyEntityUpdate,
  completePluginEvent,
  failPluginEvent,
  leaseNextPluginEvent,
  listInstallationsWithWork,
  recoverExpiredPluginEventLeases,
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
import { HostSupervisor, type SupervisorLogger } from "./supervisor";
import { PluginHostClient, PluginHostTimeoutError, PluginHostUnavailableError } from "./rpc-client";
import type { DispatcherCoreOptions } from "./config";

// ---------------------------------------------------------------------------
// Circuit breaker (per installation)
// ---------------------------------------------------------------------------

class InstallationCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInProgress = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  get open(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt < this.cooldownMs) return true;
    if (this.trialInProgress) return true;
    // half-open: allow exactly one trial request
    this.trialInProgress = true;
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInProgress = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = Date.now();
      this.consecutiveFailures = 0;
    }
    this.trialInProgress = false;
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

export interface DispatcherHandle {
  /** One scheduler pass (exposed for deterministic tests). */
  tick(): Promise<void>;
  wake(): void;
  stats(): DispatcherStats;
  stop(): Promise<void>;
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
  let ticking = false;

  const installations = new Map<string, InstallationRuntime>();

  const supervisor = new HostSupervisor(
    options,
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
    runtime.breaker.recordFailure();
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
  ): Promise<void> {
    const ok = await completePluginEvent(prisma, {
      eventId: event.id,
      applyUpdates: async (tx) => {
        for (const update of updates) {
          await applyEntityUpdate(tx, {
            deviceId: event.deviceId,
            pluginId: event.pluginId,
            update,
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

      let client: PluginHostClient;
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

      let result: unknown;
      try {
        result = await client.request(
          "plugin.handleEvent",
          {
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
            receivedAt: new Date().toISOString(),
          },
          options.eventTimeoutMs,
        );
      } catch (error) {
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
      await markCompleted(event, updates ?? [], runtime);
    } catch (error) {
      logger.error("unexpected dispatch error", {
        eventId: event.id,
        error: (error as Error).message,
      });
      try {
        await markFailed(
          event,
          `dispatcher internal error: ${(error as Error).message}`,
          false,
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
  pollTimer.unref?.();
  sweepTimer.unref?.();
  // first pass immediately; a first sweep shortly after boot
  void tick();
  const initialSweepTimer = setTimeout(() => void sweep(), 250);
  initialSweepTimer.unref?.();

  return {
    tick,
    wake() {
      void tick();
    },
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
      clearTimeout(initialSweepTimer);
      await supervisor.stopAll();
    },
  };
}

/** LISTEN/NOTIFY wake-up channel for the dispatcher entry point. */
export { PLUGIN_EVENTS_CHANNEL };
