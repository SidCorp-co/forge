import { and, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type MemorySource, memories } from '../db/schema.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { retireLapsedNotes } from './note-lifetime.js';

const DECAY_SOURCES: MemorySource[] = ['note', 'knowledge'];
const PRUNE_ZERO_RETRIEVAL_DAYS = 30;
const PRUNE_LOW_RETRIEVAL_DAYS = 90;
const PRUNE_LOW_RETRIEVAL_THRESHOLD = 3;
const PURGE_ARCHIVED_AFTER_DAYS = 90;
/** ISS-708: grace period after a stale-flag stamp before it becomes archive-eligible. */
export const STALE_UNCONFIRMED_DAYS = 14;

/** The `metadata.archivedBy` decay writes: unused, or flagged by a release and never confirmed. */
export const DECAY_UNUSED = 'decay: unused';
export const DECAY_FLAGGED = `decay: flagged stale ${STALE_UNCONFIRMED_DAYS}+ days and never confirmed after`;

// UTC arithmetic — setDate() math is local-time/DST-dependent and the
// compared columns are timestamptz.
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function daysAgoParam(days: number): SQL {
  return sqlTimestamp(daysAgo(days));
}

interface DecayResult {
  archived: number;
  /** Notes retired by the note rules (ISS-1063): their issue ended, or their window passed unchecked. */
  notesRetired: { issueEnded: number; expired: number };
  purged: number;
  durationMs: number;
}

export async function runMemoryDecay(): Promise<DecayResult> {
  const t0 = Date.now();
  // the note rules first, so a note they retire carries their reason rather than "unused"
  const notesRetired = await retireLapsedNotes(t0);

  // A confirmed verification (last_verified_at, ISS-603) counts as activity: an agent just proved
  // the row correct, so it must not be archived as "unused" even with a low retrieval count.
  const unused = sql`(
    (${memories.retrievalCount} = 0 AND GREATEST(${memories.createdAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.createdAt})) < ${daysAgoParam(PRUNE_ZERO_RETRIEVAL_DAYS)})
    OR
    (${memories.retrievalCount} < ${PRUNE_LOW_RETRIEVAL_THRESHOLD} AND GREATEST(${memories.updatedAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.updatedAt})) < ${daysAgoParam(PRUNE_LOW_RETRIEVAL_DAYS)})
  )`;
  const flaggedUnconfirmed = sql`(
    ${memories.metadata}->>'staleSince' IS NOT NULL
    AND (${memories.metadata}->>'staleSince')::timestamptz < ${daysAgoParam(STALE_UNCONFIRMED_DAYS)}
    AND (
      ${memories.lastVerifiedAt} IS NULL
      OR ${memories.lastVerifiedAt} < (${memories.metadata}->>'staleSince')::timestamptz
    )
  )`;

  // MJ-3: the rule that archived a row is written on it, so the retired list on the record it
  // names says why rather than the row vanishing from every read in silence.
  const archivedRows = await db
    .update(memories)
    .set({
      archivedAt: sql`now()`,
      metadata: sql`${memories.metadata} || jsonb_build_object('archivedBy', CASE
        WHEN ${flaggedUnconfirmed} THEN ${DECAY_FLAGGED}::text || COALESCE(' ' || (${memories.metadata}->>'supersededBy'), '')
        ELSE ${DECAY_UNUSED}::text END)`,
    })
    .where(
      and(
        isNull(memories.archivedAt),
        inArray(memories.source, DECAY_SOURCES),
        sql`(${unused} OR ${flaggedUnconfirmed})`,
      ),
    );

  // Only what decay itself archived is purged. A memory a person retired, or a note retired with
  // its issue or its window, keeps its record: retiring says nothing is deleted.
  const purgedRows = await db
    .delete(memories)
    .where(
      and(
        inArray(memories.source, DECAY_SOURCES),
        lt(memories.archivedAt, daysAgo(PURGE_ARCHIVED_AFTER_DAYS)),
        sql`${memories.metadata}->>'archivedBy' LIKE 'decay: %'`,
        sql`NOT (${memories.metadata} ? 'retired')`,
      ),
    );

  return {
    archived: archivedRows.count,
    notesRetired,
    purged: purgedRows.count,
    durationMs: Date.now() - t0,
  };
}
