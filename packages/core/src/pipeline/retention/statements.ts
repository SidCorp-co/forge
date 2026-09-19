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
   * Rows past the window that this table's rule EXEMPTS — the negation of the
   * same predicate the delete selects on, so the figure means "what the rule
   * keeps" and nothing else. It is deliberately not "what is left past the
   * window": that answer folds in any backlog the batch cap did not reach, and
   * the two are different facts. `null` where the rule exempts nothing, which is
   * reported as zero rather than left unsaid.
   */
  heldBack: ((days: number) => SQL) | null;
}

/** Over-age `job_events` rows in scope, and the rows among them the rule releases. */
const JOB_EVENTS_SOURCE = sql`
  FROM job_events e
  JOIN jobs j ON j.id = e.job_id
  LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
`;
const JOB_EVENT_RELEASABLE = sql`(
  j.agent_session_id IS NULL
  OR s.id IS NULL
  OR s.metadata ->> ${TRANSCRIPT_FINALIZED_KEY} IS NOT NULL
)`;

const jobEvents: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM job_events
    WHERE id IN (
      SELECT e.id ${JOB_EVENTS_SOURCE}
      WHERE ${olderThan(sql`e.ts`, days)}
        AND j.status IN ${JOB_TERMINAL}
        AND ${JOB_EVENT_RELEASABLE}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n ${JOB_EVENTS_SOURCE}
    WHERE ${olderThan(sql`e.ts`, days)}
      AND j.status IN ${JOB_TERMINAL}
      AND NOT ${JOB_EVENT_RELEASABLE}
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

const notTheCarryIn = (days: number): SQL => sql`
  e.id <> (
    SELECT e2.id FROM runner_events e2
    WHERE e2.runner_id = e.runner_id AND ${olderThan(sql`e2.ts`, days)}
    ORDER BY e2.ts DESC, e2.id DESC
    LIMIT 1
  )
`;

const runnerEvents: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM runner_events
    WHERE id IN (
      SELECT e.id FROM runner_events e
      WHERE ${olderThan(sql`e.ts`, days)}
        AND ${notTheCarryIn(days)}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n FROM runner_events e
    WHERE ${olderThan(sql`e.ts`, days)}
      AND NOT ${notTheCarryIn(days)}
  `,
};

const ENTITY_IS_TERMINAL = sql`
  CASE k.entity
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
`;

const kernelTransitions: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM kernel_transitions
    WHERE id IN (
      SELECT k.id FROM kernel_transitions k
      WHERE ${olderThan(sql`k.created_at`, days)}
        AND ${ENTITY_IS_TERMINAL}
      LIMIT ${limit}
    )
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n FROM kernel_transitions k
    WHERE ${olderThan(sql`k.created_at`, days)}
      AND NOT ${ENTITY_IS_TERMINAL}
  `,
};

const SESSION_EVENTS_RELEASABLE = (days: number): SQL => sql`(
  s.status IN ${SESSION_TERMINAL}
  AND s.metadata ->> ${TRANSCRIPT_FINALIZED_KEY} IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_session_events e2
    WHERE e2.agent_session_id = e.agent_session_id
      AND e2.ts >= now() - make_interval(days => ${days})
  )
)`;

const AGENT_SESSION_EVENTS_SOURCE = sql`
  FROM agent_session_events e
  JOIN agent_sessions s ON s.id = e.agent_session_id
`;

const RELEASABLE_SESSIONS = (days: number, limit: number): SQL => sql`(
  SELECT s.id FROM agent_sessions s
  WHERE s.status IN ${SESSION_TERMINAL}
    AND s.metadata ->> ${TRANSCRIPT_FINALIZED_KEY} IS NOT NULL
    AND EXISTS (SELECT 1 FROM agent_session_events e WHERE e.agent_session_id = s.id)
    AND NOT EXISTS (
      SELECT 1 FROM agent_session_events e2
      WHERE e2.agent_session_id = s.id
        AND e2.ts >= now() - make_interval(days => ${days})
    )
  LIMIT ${limit}
)`;

const agentSessionEvents: TableStatements = {
  deleteBatch: (days, limit) => sql`
    DELETE FROM agent_session_events
    WHERE agent_session_id IN ${RELEASABLE_SESSIONS(days, limit)}
    RETURNING id
  `,
  heldBack: (days) => sql`
    SELECT count(*)::int AS n ${AGENT_SESSION_EVENTS_SOURCE}
    WHERE ${olderThan(sql`e.ts`, days)}
      AND NOT ${SESSION_EVENTS_RELEASABLE(days)}
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
  agent_session_events: agentSessionEvents,
  queue_snapshots: queueSnapshots,
  runner_events: runnerEvents,
  kernel_transitions: kernelTransitions,
  retrieval_analytics: retrievalAnalytics,
};

/**
 * Whether a job's surviving events are the whole history it produced.
 *
 * `events-routes.ts` numbers them `COALESCE(MAX(seq), 0) + i + 1`, so a whole
 * history runs 1..N with nothing missing. `(job_id, seq)` is unique, so a count
 * equal to the maximum means no gap anywhere.
 */
const HISTORY_IS_WHOLE = sql`coalesce((
  SELECT min(e2.seq) = 1 AND count(*) = max(e2.seq)
  FROM job_events e2 WHERE e2.job_id = j.id
), false)`;

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
