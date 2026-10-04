import { type SQL, sql } from 'drizzle-orm';
import { olderThan, type TableStatements } from '../db/retention-shape.js';

const notTheCarryIn = (days: number): SQL => sql`
  e.id <> (
    SELECT e2.id FROM runner_events e2
    WHERE e2.runner_id = e.runner_id AND ${olderThan(sql`e2.ts`, days)}
    ORDER BY e2.ts DESC, e2.id DESC
    LIMIT 1
  )
`;

export const runnerEventsRetention: TableStatements = {
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
