import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { utcDateTrunc, utcDayText } from '../lib/time-buckets.js';
import { walkFlow, weekStartsEnding } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import type { PulseFlowWeek } from './pulse-types.js';

const toMap = (rows: Array<{ week: string; n: number }>) =>
  new Map(rows.map((r) => [r.week, Number(r.n)]));

export async function readPulseFlow(projectIds: string[], now: Date): Promise<PulseFlowWeek[]> {
  const weekStarts = weekStartsEnding(now);
  const windowStart = weekStarts[0];
  const scope = idList(projectIds);
  const terminal = idList(ISSUE_TERMINAL_STATUSES);

  const weekExpr = utcDayText(utcDateTrunc('week', sql`a.created_at`));
  const intoTerminal = sql`a.action = 'issue.statusChanged' AND a.payload ->> 'to' IN (${terminal})`;
  const outOfTerminal = sql`a.action = 'issue.statusChanged' AND a.payload ->> 'from' IN (${terminal})`;

  const [createdRows, closedRows, reopenedRows, before] = await Promise.all([
    db.execute(sql`
      SELECT ${utcDayText(utcDateTrunc('week', sql`i.created_at`))} AS week,
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
        terminal.closed,
        terminal.reopened
      FROM (
        SELECT
          count(*) FILTER (WHERE ${intoTerminal})::int AS closed,
          count(*) FILTER (WHERE ${outOfTerminal})::int AS reopened
        FROM activity_log a JOIN issues i ON i.id = a.issue_id
        WHERE i.project_id IN (${scope}) AND a.created_at < ${windowStart}::date
          AND a.action = 'issue.statusChanged'
      ) terminal
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
