import { sql } from 'drizzle-orm';
import { JOB_TERMINAL, olderThan, type TableStatements } from '../db/retention-shape.js';
import { TRANSCRIPT_FINALIZED_KEY } from '../db/transcript-marker.js';

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

export const jobEventsRetention: TableStatements = {
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
