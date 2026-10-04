import { sql } from 'drizzle-orm';
import {
  ISSUE_TERMINAL,
  JOB_TERMINAL,
  olderThan,
  RUN_TERMINAL,
  SESSION_TERMINAL,
  type TableStatements,
} from '../pipeline/retention/shape.js';

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
    WHEN 'issue' THEN NOT EXISTS (
      SELECT 1 FROM issues i
      WHERE i.id = k.entity_id AND i.status NOT IN ${ISSUE_TERMINAL}
    )
    ELSE false
  END
`;

export const kernelTransitionsRetention: TableStatements = {
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
