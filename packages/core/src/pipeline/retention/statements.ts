/**
 * ISS-1027 — one batched delete and one held-back count per swept table.
 *
 * The statements live here rather than inside the sweep loop because what makes
 * each table's rule correct is a predicate, not a window: a `job_events` row is
 * only removable once the transcript it would rebuild is recorded as finalised,
 * a `kernel_transitions` row only once the entity it records is terminal, and a
 * runner's newest event never. Those predicates ARE the rule, so they are read
 * beside the policy that states them rather than reconstructed from prose.
 *
 * Every delete is bounded by a `LIMIT` and returns the ids it removed, so the
 * count is the database's answer rather than a driver-shape guess, and the loop
 * that calls it stops on a short batch.
 */

import { type SQL, sql } from 'drizzle-orm';
import {
  attemptedMerge,
  TRANSCRIPT_ATTEMPTED_KEY,
  TRANSCRIPT_FINALIZED_KEY,
} from '../../db/transcript-marker.js';

/** Terminal `jobs.status`, as `lifecycle/transition-guard.test.ts` enumerates them. */
const JOB_TERMINAL = sql`('done', 'failed', 'cancelled')`;
/** Terminal `agent_sessions.status`. */
const SESSION_TERMINAL = sql`('completed', 'failed', 'completed_via_recovery', 'cancelled_stale')`;
/** Terminal `pipeline_runs.status`. */
const RUN_TERMINAL = sql`('completed', 'failed', 'cancelled')`;

function olderThan(column: SQL, days: number): SQL {
  return sql`${column} < now() - make_interval(days => ${days})`;
}

/** What one table owes the sweep. */
export interface TableStatements {
  /** One bounded batch of deletions, returning the ids removed. */
  deleteBatch: (days: number, limit: number) => SQL;
  /**
   * Rows past the window that this sweep's predicates would not let it remove,
   * counted AFTER the batches have run — at which point everything eligible has
   * gone, so what is left past the window is exactly what was held. `null` where
   * the table's rule holds nothing back, which is reported as zero rather than
   * left unsaid.
   */
  heldBack: ((days: number) => SQL) | null;
}

// cm:guard the `s.id IS NULL` arm is not defensive noise: `jobs.agent_session_id` can point at a session row that no longer exists, and without that arm such a job's events match neither the delete nor any repair, so they are held for ever by a transcript that cannot be rebuilt into anything. A row with no session to protect has nothing to protect.
const jobEvents: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM job_events
    WHERE id IN (
      SELECT e.id
      FROM job_events e
      JOIN jobs j ON j.id = e.job_id
      LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE ${olderThan(sql`e.ts`, days)}
        AND j.status IN ${JOB_TERMINAL}
        AND (
          j.agent_session_id IS NULL
          OR s.id IS NULL
          OR s.metadata ->> ${TRANSCRIPT_FINALIZED_KEY} IS NOT NULL
        )
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n
    FROM job_events e
    JOIN jobs j ON j.id = e.job_id
    WHERE ${olderThan(sql`e.ts`, days)}
      AND j.status IN ${JOB_TERMINAL}
  `,
};

const queueSnapshots: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM queue_snapshots
    WHERE id IN (
      SELECT id FROM queue_snapshots
      WHERE ${olderThan(sql`ts`, days)}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: null,
};

// cm:guard the correlated subquery is scoped to events BEFORE THE CUTOFF, and the scope is the whole point. `metrics/queries.ts`'s `runner_uptime` carries in the LATEST event before the cutoff, which is what sets the leading edge of the chart; keeping each runner's newest event OVERALL does not keep that one. A runner that went online 100 days ago and offline 10 days ago has its newest event inside the window, so the unscoped form would delete the online event the chart needs and the uptime would read wrong rather than absent — the failure this repo cares about more.
const runnerEvents: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM runner_events
    WHERE id IN (
      SELECT e.id FROM runner_events e
      WHERE ${olderThan(sql`e.ts`, days)}
        AND e.id <> (
          SELECT e2.id FROM runner_events e2
          WHERE e2.runner_id = e.runner_id AND ${olderThan(sql`e2.ts`, days)}
          ORDER BY e2.ts DESC, e2.id DESC
          LIMIT 1
        )
      LIMIT ${limit}
    )
    RETURNING id
  `,
  // Counted after the batches, so every pre-cutoff row still standing is a carry-in this rule kept.
  heldBack: (days) => sql`
    SELECT count(*)::int AS n FROM runner_events WHERE ${olderThan(sql`ts`, days)}
  `,
};

// cm:guard the `ELSE false` arm is load-bearing: `kernel_transitions.entity` carries no foreign key, so an entity name this CASE does not know is a row whose parent nothing here can look up. Widening the ELSE to `true` deletes it on age alone, which is the one direction this table may not fail in — it is the audit of terminal kernel flips, and an unknown entity means a writer this sweep has not been taught about.
const kernelTransitions: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM kernel_transitions
    WHERE id IN (
      SELECT k.id FROM kernel_transitions k
      WHERE ${olderThan(sql`k.created_at`, days)}
        AND CASE k.entity
          WHEN 'job' THEN NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = k.entity_id AND j.status NOT IN ${JOB_TERMINAL}
          )
          WHEN 'session' THEN NOT EXISTS (
            SELECT 1 FROM agent_sessions s
            WHERE s.id = k.entity_id AND s.status NOT IN ${SESSION_TERMINAL}
          )
          WHEN 'run' THEN NOT EXISTS (
            SELECT 1 FROM pipeline_runs r
            WHERE r.id = k.entity_id AND r.status NOT IN ${RUN_TERMINAL}
          )
          ELSE false
        END
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n FROM kernel_transitions
    WHERE ${olderThan(sql`created_at`, days)}
  `,
};

const retrievalAnalytics: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM retrieval_analytics
    WHERE id IN (
      SELECT id FROM retrieval_analytics
      WHERE ${olderThan(sql`created_at`, days)}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: null,
};

/** Keyed by the physical table name a `RetentionRule` carries. */
export const RETENTION_STATEMENTS: Readonly<Record<string, TableStatements>> = {
  job_events: jobEvents,
  queue_snapshots: queueSnapshots,
  runner_events: runnerEvents,
  kernel_transitions: kernelTransitions,
  retrieval_analytics: retrievalAnalytics,
};

/**
 * `events-routes.ts` numbers a job's events `COALESCE(MAX(seq), 0) + i + 1`, so
 * the first event a job ever writes is seq 1 and a surviving history that does
 * not start there is a SUFFIX of what the job produced.
 */
const HISTORY_IS_WHOLE = sql`(SELECT min(e2.seq) FROM job_events e2 WHERE e2.job_id = j.id) = 1`;

function unfinalizedOverAge(days: number): SQL {
  return sql`
    j.status IN ${JOB_TERMINAL}
    AND s.metadata ->> ${TRANSCRIPT_FINALIZED_KEY} IS NULL
    AND EXISTS (
      SELECT 1 FROM job_events e
      WHERE e.job_id = j.id AND ${olderThan(sql`e.ts`, days)}
    )
  `;
}

// cm:guard `HISTORY_IS_WHOLE` is what stops this pass DESTROYING the record it exists to protect. A derive is a full rebuild that replaces `agent_sessions.messages` outright, so running it over a suffix of a job's events overwrites a complete stored transcript with a truncated one and then marks that truncation final. The pre-ISS-1027 sweep deleted `job_events` per ROW and not per job, so a job that ran across its window really does have a suffix left, and those sessions are the ones this pass would meet first.
/**
 * The sessions whose transcripts the sweep should finalise so their events can
 * go on a later run.
 *
 * Ordered least-recently-attempted first — the attempt stamp ascending with the
 * never-attempted ahead of it — rather than oldest first, because a session
 * that fails every time would otherwise take the whole nightly budget for ever
 * and no other session would be attempted again.
 */
export function repairCandidates(days: number, limit: number): SQL {
  return sql`
    SELECT j.id AS job_id, j.agent_session_id AS session_id
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE ${unfinalizedOverAge(days)}
      AND ${HISTORY_IS_WHOLE}
    ORDER BY (s.metadata ->> ${TRANSCRIPT_ATTEMPTED_KEY}) ASC NULLS FIRST, j.finished_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
}

/**
 * The sessions this sweep can neither finalise nor let go: over-age, unmarked,
 * and holding only a suffix of their job's events. Reported by id rather than
 * repaired or expired, because both of those destroy something — one the stored
 * transcript, the other the events — and which of the two is worth keeping is a
 * person's call and not a predicate's.
 */
export function truncatedHistories(days: number, limit: number): SQL {
  return sql`
    SELECT j.agent_session_id AS session_id
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE ${unfinalizedOverAge(days)}
      AND NOT ${HISTORY_IS_WHOLE}
    ORDER BY j.finished_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
}

/** Stamp the attempt, before the derive runs, so a failure rotates to the back. */
export function stampFinalizeAttempt(sessionId: string, at: Date): SQL {
  return sql`UPDATE agent_sessions SET metadata = ${attemptedMerge(at)} WHERE id = ${sessionId}`;
}
