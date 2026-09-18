import { and, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
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
 *  - flagged `metadata.staleSince` (ISS-708: a later release's
 *    `reconcileForReleasedIssue` marked it possibly-stale) more than 14 days
 *    ago AND not re-verified since → archive, INDEPENDENT of retrievalCount.
 *    This is the fix for retrieval-decay shielding a popular-but-wrong note:
 *    usage alone no longer grants immunity once a release has contradicted
 *    the row and nobody re-confirmed it within the grace period.
 *  - archived more than 90 days ago → purge (hard delete)
 */

export const MEMORY_DECAY_QUEUE = 'memory-decay';

export const DECAY_SOURCES: MemorySource[] = ['note', 'knowledge'];
export const PRUNE_ZERO_RETRIEVAL_DAYS = 30;
export const PRUNE_LOW_RETRIEVAL_DAYS = 90;
export const PRUNE_LOW_RETRIEVAL_THRESHOLD = 3;
export const PURGE_ARCHIVED_AFTER_DAYS = 90;
/** ISS-708: grace period after a stale-flag stamp before it becomes archive-eligible. */
export const STALE_UNCONFIRMED_DAYS = 14;

// UTC arithmetic — setDate() math is local-time/DST-dependent and the
// compared columns are timestamptz.
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// cm:why ISS-1021 — a raw `sql` fragment carries no column type, so a bare `${date}` reaches
// postgres-js as an untyped parameter it refuses to serialise, throwing `The "string" argument must
// be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date`. The
// archive UPDATE below has thrown on exactly that since ISS-708 introduced the fragment: the daily
// 03:30 sweep logged `memory.decay: sweep failed` and archived nothing, and the purge that runs
// after it never ran at all. `decay.test.ts` could not see it because it mocks `../db/client.js`,
// so no assertion in the tree ever reached a real driver. Same defect and same fix as
// `issues/merge-marker.ts:stampIssueMergedAt` (ISS-959, a live 500 on beta for every
// mergedAt-supplied call), which is where this repo settled on ISO-string-plus-cast.
// The typed `lt()` on the purge statement does NOT need this and must not be changed to it:
// drizzle knows the column there and maps the Date itself.
function daysAgoParam(days: number): SQL {
  return sql`${daysAgo(days).toISOString()}::timestamptz`;
}

export interface DecayResult {
  archived: number;
  purged: number;
  durationMs: number;
}

export async function runMemoryDecay(): Promise<DecayResult> {
  const t0 = Date.now();

  // cm:guard ISS-1021 — `rowCount`, not `.returning({ id })`. These two statements exist to
  // report HOW MANY rows moved, and returning every id materialised the whole archived and purged
  // sets over the wire for a `.length` call that the command tag already carries. Nothing reads
  // the ids — if a caller ever needs them, take them deliberately rather than by re-adding a
  // RETURNING nobody asked for.
  const archivedRows = await db
    .update(memories)
    .set({ archivedAt: sql`now()` })
    .where(
      and(
        isNull(memories.archivedAt),
        inArray(memories.source, DECAY_SOURCES),
        // A confirmed verification (last_verified_at, ISS-603) counts as
        // activity: an agent just proved the row correct, so it must not be
        // archived as "unused" even with a low retrieval count.
        sql`(
          (${memories.retrievalCount} = 0 AND GREATEST(${memories.createdAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.createdAt})) < ${daysAgoParam(PRUNE_ZERO_RETRIEVAL_DAYS)})
          OR
          (${memories.retrievalCount} < ${PRUNE_LOW_RETRIEVAL_THRESHOLD} AND GREATEST(${memories.updatedAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.updatedAt})) < ${daysAgoParam(PRUNE_LOW_RETRIEVAL_DAYS)})
          OR
          (
            ${memories.metadata}->>'staleSince' IS NOT NULL
            AND (${memories.metadata}->>'staleSince')::timestamptz < ${daysAgoParam(STALE_UNCONFIRMED_DAYS)}
            AND (
              ${memories.lastVerifiedAt} IS NULL
              OR ${memories.lastVerifiedAt} < (${memories.metadata}->>'staleSince')::timestamptz
            )
          )
        )`,
      ),
    );

  const purgedRows = await db
    .delete(memories)
    .where(
      and(
        inArray(memories.source, DECAY_SOURCES),
        lt(memories.archivedAt, daysAgo(PURGE_ARCHIVED_AFTER_DAYS)),
      ),
    );

  return {
    archived: archivedRows.count,
    purged: purgedRows.count,
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
