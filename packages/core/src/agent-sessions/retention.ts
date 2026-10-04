import { type SQL, sql } from 'drizzle-orm';
import { TRANSCRIPT_FINALIZED_KEY } from '../db/transcript-marker.js';
import { olderThan, SESSION_TERMINAL, type TableStatements } from '../pipeline/retention/shape.js';

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

export const agentSessionEventsRetention: TableStatements = {
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
