import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { utcDateTrunc } from '../lib/time-buckets.js';

export interface ShippedDay {
  projectId: string;
  date: string;
  count: number;
}

/**
 * Issues shipped per UTC day, dense over the calendar: exactly `days` rows per project, one for each
 * consecutive UTC date ending at `asOf`'s, a date with nothing shipped included at 0.
 *
 * `first_day` is computed once and bounds both the calendar and the rows counted, so the axis a chart
 * draws from this and the total beneath it cannot describe two different windows (ISS-1149).
 */
export async function shippedPerDay(
  projectIds: readonly string[],
  days: number,
  asOf: Date,
): Promise<ShippedDay[]> {
  if (projectIds.length === 0) return [];
  const ids = sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    WITH bounds AS (
      SELECT (${utcDateTrunc('day', sql`${asOf.toISOString()}::timestamptz`)} AT TIME ZONE 'UTC')
               - ((${days}::int - 1) * interval '1 day') AS first_day
    ),
    calendar AS (
      SELECT to_char(d, 'YYYY-MM-DD') AS date
      FROM bounds,
           generate_series(bounds.first_day,
                           bounds.first_day + ((${days}::int - 1) * interval '1 day'),
                           interval '1 day') AS d
    ),
    shipped AS (
      SELECT i.project_id,
             to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             count(*)::int AS n
      FROM activity_log al
      JOIN issues i ON i.id = al.issue_id
      CROSS JOIN bounds
      WHERE al.action = 'issue.statusChanged'
        AND al.payload ->> 'to' IN ('closed', 'released', 'awaiting_release')
        AND al.created_at >= bounds.first_day AT TIME ZONE 'UTC'
        AND al.created_at < (bounds.first_day + (${days}::int * interval '1 day')) AT TIME ZONE 'UTC'
        AND i.project_id IN (${ids})
      GROUP BY 1, 2
    )
    SELECT p.project_id AS "projectId", c.date, COALESCE(s.n, 0)::int AS count
    FROM unnest(ARRAY[${ids}]) AS p(project_id)
    CROSS JOIN calendar c
    LEFT JOIN shipped s ON s.project_id = p.project_id AND s.date = c.date
    ORDER BY p.project_id, c.date
  `)) as unknown as ShippedDay[];
  return rows.map((r) => ({ projectId: r.projectId, date: r.date, count: Number(r.count) }));
}
