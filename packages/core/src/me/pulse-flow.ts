import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { walkFlow, weekStartsEnding } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import type { PulseFlowWeek } from './pulse-types.js';

// cm:guard reads `dropped` beside `closed` as terminal, and BOTH spellings of the release rung are irrelevant here: an issue is finished when it enters `closed` or `dropped`, and `awaiting_release` is still work in flight. A `released` payload from before migration 0228 is a move INTO the release rung, not out of the backlog.
const TERMINAL = ['closed', 'dropped'] as const;

const toMap = (rows: Array<{ week: string; n: number }>) =>
  new Map(rows.map((r) => [r.week, Number(r.n)]));

export async function readPulseFlow(projectIds: string[], now: Date): Promise<PulseFlowWeek[]> {
  const weekStarts = weekStartsEnding(now);
  const windowStart = weekStarts[0];
  const scope = idList(projectIds);
  const terminal = idList(TERMINAL);

  const weekExpr = sql`to_char(date_trunc('week', a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const intoTerminal = sql`a.action = 'issue.statusChanged' AND a.payload ->> 'to' IN (${terminal})`;
  const outOfTerminal = sql`a.action = 'issue.statusChanged' AND a.payload ->> 'from' IN (${terminal})`;

  const [createdRows, closedRows, reopenedRows, before] = await Promise.all([
    db.execute(sql`
      SELECT to_char(date_trunc('week', i.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
             count(*)::int AS n
      FROM issues i
      WHERE i.project_id IN (${scope}) AND i.created_at >= ${windowStart}::date
      GROUP BY 1
    `) as unknown as Promise<Array<{ week: string; n: number }>>,
    db.execute(sql`
      SELECT ${weekExpr} AS week, count(*)::int AS n
      FROM activity_log a JOIN issues i ON i.id = a.issue_id
      WHERE i.project_id IN (${scope}) AND a.created_at >= ${windowStart}::date AND ${intoTerminal}
      GROUP BY 1
    `) as unknown as Promise<Array<{ week: string; n: number }>>,
    db.execute(sql`
      SELECT ${weekExpr} AS week, count(*)::int AS n
      FROM activity_log a JOIN issues i ON i.id = a.issue_id
      WHERE i.project_id IN (${scope}) AND a.created_at >= ${windowStart}::date AND ${outOfTerminal}
      GROUP BY 1
    `) as unknown as Promise<Array<{ week: string; n: number }>>,
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM issues i
          WHERE i.project_id IN (${scope}) AND i.created_at < ${windowStart}::date) AS created,
        (SELECT count(*)::int FROM activity_log a JOIN issues i ON i.id = a.issue_id
          WHERE i.project_id IN (${scope}) AND a.created_at < ${windowStart}::date
            AND ${intoTerminal}) AS closed,
        (SELECT count(*)::int FROM activity_log a JOIN issues i ON i.id = a.issue_id
          WHERE i.project_id IN (${scope}) AND a.created_at < ${windowStart}::date
            AND ${outOfTerminal}) AS reopened
    `) as unknown as Promise<Array<{ created: number; closed: number; reopened: number }>>,
  ]);

  const b = before[0] ?? { created: 0, closed: 0, reopened: 0 };
  return walkFlow(
    weekStarts,
    {
      created: toMap(createdRows),
      closed: toMap(closedRows),
      reopened: toMap(reopenedRows),
    },
    Math.max(0, Number(b.created) - Number(b.closed) + Number(b.reopened)),
  );
}
