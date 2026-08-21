import type { DbExecutor } from "../db";

export interface PluginRetentionOptions {
  /** Age after which terminal plugin events can be removed. */
  eventRetentionMs: number;
  /** Age after which entity history rows can be removed. */
  entityHistoryRetentionMs: number;
  /** Maximum rows deleted by one SQL statement. */
  batchSize?: number;
}

export interface PluginRetentionResult {
  pluginEventsDeleted: number;
  entityHistoryDeleted: number;
}

function retentionSeconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite duration`);
  }
  return value / 1000;
}

function retentionBatchSize(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("retention batch size must be a positive integer");
  }
  return Math.min(value, 10_000);
}

/**
 * Deletes only terminal plugin events and old entity samples, in bounded
 * batches so a large installation never holds one long-running delete
 * transaction. Each statement is independently committed by Prisma.
 */
export async function prunePluginData(
  prisma: DbExecutor,
  options: PluginRetentionOptions,
): Promise<PluginRetentionResult> {
  const eventSeconds = retentionSeconds(options.eventRetentionMs, "event retention");
  const historySeconds = retentionSeconds(
    options.entityHistoryRetentionMs,
    "entity history retention",
  );
  const batchSize = retentionBatchSize(options.batchSize);
  let pluginEventsDeleted = 0;
  let entityHistoryDeleted = 0;

  for (;;) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      WITH doomed AS (
        SELECT id
        FROM plugin_events
        WHERE state IN ('completed', 'dead')
          AND finished_at < now() - make_interval(secs => ${eventSeconds}::double precision)
        ORDER BY finished_at, id
        LIMIT ${batchSize}
      )
      DELETE FROM plugin_events pe
      USING doomed
      WHERE pe.id = doomed.id
      RETURNING pe.id
    `;
    pluginEventsDeleted += rows.length;
    if (rows.length < batchSize) break;
  }

  for (;;) {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      WITH doomed AS (
        SELECT id
        FROM entity_history
        WHERE ingested_at < now() - make_interval(secs => ${historySeconds}::double precision)
        ORDER BY ingested_at, id
        LIMIT ${batchSize}
      )
      DELETE FROM entity_history eh
      USING doomed
      WHERE eh.id = doomed.id
      RETURNING eh.id
    `;
    entityHistoryDeleted += rows.length;
    if (rows.length < batchSize) break;
  }

  return { pluginEventsDeleted, entityHistoryDeleted };
}
