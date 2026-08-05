/**
 * Rollout advance poller for the API process (proposal 19 D7).
 *
 * Runs advanceRollouts() on a fixed interval. The rollout state machine is
 * entirely database-driven: conditional UPDATEs make concurrent API
 * instances safe (the loser updates 0 rows), and the poll interval is the
 * only clock the rollout needs (rollouts are a slow-moving concern; a
 * 30-second granularity is far finer than the hour-scale gating settings).
 */

import { advanceRollouts, type PrismaClient } from "@soulcloud/core";

export interface RolloutPollerOptions {
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
}

export interface RolloutPollerLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface RolloutPoller {
  /** Stops the poller. */
  stop: () => void;
}

/**
 * Starts the rollout advance poller. Call stop() during shutdown so the
 * process can exit cleanly.
 */
export function startRolloutPoller(
  prisma: PrismaClient,
  options: RolloutPollerOptions,
  log: RolloutPollerLog,
): RolloutPoller {
  let running = false;
  let stopped = false;

  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await advanceRollouts(prisma);
      if (
        summary.phasesActivated > 0 ||
        summary.phasesCompleted > 0 ||
        summary.rolloutsPaused > 0 ||
        summary.rolloutsCompleted > 0 ||
        summary.targetsStalled > 0
      ) {
        log.info("rollout advance pass", { ...summary });
      }
    } catch (error) {
      log.warn("rollout advance pass failed", {
        error: (error as Error).message,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(poll, options.pollIntervalMs);
  // first pass shortly after startup
  const first = setTimeout(() => void poll(), 500);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
