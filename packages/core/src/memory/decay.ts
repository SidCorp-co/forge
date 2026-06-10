import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';

/**
 * memory-v2 phase 2 — deterministic decay, ported from forge-agents
 * memory-lifecycle.ts (thresholds preserved) with two adaptations:
 *
 *  1. Archive, never delete. `archived_at` hides the row from every read
 *     surface; a fresh write to the same natural key revives it (indexer
 *     resets archived_at). Hard purge only after a further grace period.
 *  2. Scope: ONLY agent-curated sources (`note`, `knowledge`). Lifecycle
 *     mirrors (`issue`, `decision`, `policy`) track their source records —
 *     their lifecycle belongs to those records, not to usage stats.
 *
 * Rules (usage comes from `retrieval_count`, bumped on search hits and
 * ci-fix-pattern injections):
 *  - never retrieved and older than 30 days → archive
 *  - fewer than 3 retrievals and not updated in 90 days → archive
 *  - archived more than 90 days ago → purge (hard delete)
 */

export const MEMORY_DECAY_QUEUE = 'memory-decay';

export const DECAY_SOURCES: MemorySource[] = ['note', 'knowledge'];
export const PRUNE_ZERO_RETRIEVAL_DAYS = 30;
export const PRUNE_LOW_RETRIEVAL_DAYS = 90;
export const PRUNE_LOW_RETRIEVAL_THRESHOLD = 3;
export const PURGE_ARCHIVED_AFTER_DAYS = 90;

// UTC arithmetic — setDate() math is local-time/DST-dependent and the
// compared columns are timestamptz.
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface DecayResult {
  archived: number;
  purged: number;
  durationMs: number;
}

export async function runMemoryDecay(): Promise<DecayResult> {
  const t0 = Date.now();

  const archivedRows = await db
    .update(memories)
    .set({ archivedAt: sql`now()` })
    .where(
      and(
        isNull(memories.archivedAt),
        inArray(memories.source, DECAY_SOURCES),
        sql`(
          (${memories.retrievalCount} = 0 AND ${memories.createdAt} < ${daysAgo(PRUNE_ZERO_RETRIEVAL_DAYS)})
          OR
          (${memories.retrievalCount} < ${PRUNE_LOW_RETRIEVAL_THRESHOLD} AND ${memories.updatedAt} < ${daysAgo(PRUNE_LOW_RETRIEVAL_DAYS)})
        )`,
      ),
    )
    .returning({ id: memories.id });

  const purgedRows = await db
    .delete(memories)
    .where(
      and(
        inArray(memories.source, DECAY_SOURCES),
        lt(memories.archivedAt, daysAgo(PURGE_ARCHIVED_AFTER_DAYS)),
      ),
    )
    .returning({ id: memories.id });

  return {
    archived: archivedRows.length,
    purged: purgedRows.length,
    durationMs: Date.now() - t0,
  };
}

let registered = false;

export async function registerMemoryDecay(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_DECAY_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MEMORY_DECAY_QUEUE, async () => {
    try {
      const result = await runMemoryDecay();
      logger.info(result, 'memory.decay: sweep complete');
    } catch (err) {
      logger.error({ err }, 'memory.decay: sweep failed');
      throw err;
    }
  });
  // Daily, off-peak. Same cadence as forge-agents' dream poller.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(MEMORY_DECAY_QUEUE, '30 3 * * *');
  registered = true;
}

export function resetMemoryDecayForTest(): void {
  registered = false;
}
