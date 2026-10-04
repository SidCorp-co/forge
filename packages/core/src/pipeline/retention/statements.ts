import { type SQL, sql } from 'drizzle-orm';
import { agentSessionEventsRetention } from '../../agent-sessions/retention.js';
import { TRANSCRIPT_ATTEMPTED_KEY, TRANSCRIPT_FINALIZED_KEY } from '../../db/transcript-marker.js';
import { jobEventsRetention } from '../../jobs/retention.js';
import { kernelTransitionsRetention } from '../../lifecycle/retention.js';
import { retrievalAnalyticsRetention } from '../../memory/retention.js';
import { runnerEventsRetention } from '../../runners/retention.js';
import { JOB_TERMINAL, olderThan, type TableStatements } from './shape.js';

export type { TableStatements } from './shape.js';

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

/** Keyed by the physical table name a `RetentionRule` carries. */
export const RETENTION_STATEMENTS: Readonly<Record<string, TableStatements>> = {
  job_events: jobEventsRetention,
  agent_session_events: agentSessionEventsRetention,
  queue_snapshots: queueSnapshots,
  runner_events: runnerEventsRetention,
  kernel_transitions: kernelTransitionsRetention,
  retrieval_analytics: retrievalAnalyticsRetention,
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
