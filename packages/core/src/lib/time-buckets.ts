import { type SQL, sql } from 'drizzle-orm';

/**
 * UTC-pinned `date_trunc` over a `timestamptz`, and the normalizer that reads
 * its value back.
 *
 * Bare `date_trunc(unit, ts)` floors in the SESSION `TimeZone`, so the same row
 * lands in a different bucket on a server in `Asia/Ho_Chi_Minh` than on one in
 * `UTC`. Every caller here pairs the SQL with bucket boundaries computed in JS
 * at UTC midnight and joins the two by exact ISO string, so off UTC the join
 * matches nothing and the series gap-fills to zero with no error (ISS-942).
 */

// cm:guard every `date_trunc` over a timestamptz in core goes through this — a bare one floors in the session TimeZone, and its rows then miss the UTC boundaries `bucketTimestamps` / `bucketBoundaries` generate, so the chart reads empty instead of wrong
// cm:why the inner `AT TIME ZONE 'UTC'` yields the naive UTC wall clock to floor; the outer one returns a timestamptz at that instant, so the driver's rendering stays correct under any session TimeZone
export function utcDateTrunc(unit: SQL | string, column: SQL): SQL {
  return sql`date_trunc(${unit}, ${column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

/**
 * `YYYY-MM-DD` for a `timestamptz`, in UTC — the day label a chart axis shows.
 *
 * Lexical order is chronological order, so this is also the GROUP BY and the
 * ORDER BY, and no second expression can drift from the one that was selected.
 */
export function utcDayText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
}

// cm:edge contract -> packages/core/src/metrics/queries.ts#bucketTimestamps — this must produce the same ISO key that generator does, or every bucketed series densifies to its defaults
export function bucketIso(x: unknown): string {
  if (x instanceof Date) return x.toISOString();
  return new Date(x as string).toISOString();
}
