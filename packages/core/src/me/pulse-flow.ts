import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { utcDateTrunc, utcDayText } from '../lib/time-buckets.js';
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
    // cm:guard the two pre-window `activity_log` counts are ONE pass filtered two ways, not two scans of the same rows: both read the same predicate over the same join and differ only in which side of the transition they look at. The issue count stays its own subquery because it counts a different table (ISS-1022).
    // cm:guard the window is NOT narrowed and must not be: this is the cumulative backlog the walk starts from, so a time bound would not trim rows, it would report a different number. No index serves this read and none is expected to — it reads everything older than the window, so a sequential scan is the right plan, and the fold above is the only thing that halves it (ISS-1022).
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
