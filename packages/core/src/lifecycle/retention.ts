import { sql } from 'drizzle-orm';
import {
  ISSUE_TERMINAL,
  JOB_TERMINAL,
  olderThan,
  RUN_TERMINAL,
  SESSION_TERMINAL,
  type TableStatements,
} from '../db/retention-shape.js';

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

/**
 * A kernel record of a move goes once it is past the window and the item it records has ended;
 * while the item is live it stays, whatever its age. `kernel_refused_moves` keeps the rule
 * `kernel_transitions` keeps, so a period's passed and refused moves are reaped alike.
 */
function kernelRecordRetention(
  table: 'kernel_transitions' | 'kernel_refused_moves',
): TableStatements {
  const name = sql.raw(table);
  return {
    deleteBatch: (days, limit) => sql`
      DELETE FROM ${name}
      WHERE id IN (
        SELECT k.id FROM ${name} k
        WHERE ${olderThan(sql`k.created_at`, days)}
          AND ${ENTITY_IS_TERMINAL}
        LIMIT ${limit}
      )
      RETURNING id
    `,
    heldBack: (days) => sql`
      SELECT count(*)::int AS n FROM ${name} k
      WHERE ${olderThan(sql`k.created_at`, days)}
        AND NOT ${ENTITY_IS_TERMINAL}
    `,
  };
}

export const kernelTransitionsRetention = kernelRecordRetention('kernel_transitions');

export const kernelRefusedMovesRetention = kernelRecordRetention('kernel_refused_moves');
