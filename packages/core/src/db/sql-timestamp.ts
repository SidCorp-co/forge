import { type SQL, sql } from 'drizzle-orm';
import type postgres from 'postgres';

/**
 * The one way a timestamp enters a raw `sql` template. drizzle's postgres-js driver makes the
 * timestamptz serializer the identity, so a bare `${date}` reaches the wire as a Date and the
 * driver throws; query-builder comparisons on a timestamp column are encoded by the column and
 * need none of this.
 */
export function sqlTimestamp(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

const TIMESTAMPTZ_OID = '1184';

/**
 * Replace the driver's unreadable failure for a bare Date in raw sql with one that names the
 * helper. postgres-js infers 1184 for every Date (or array of them), so this is the only
 * serializer such a parameter reaches.
 */
export function refuseBareDates(client: postgres.Sql): void {
  const serializers = client.options.serializers as Record<string, (x: unknown) => unknown>;
  const pass = serializers[TIMESTAMPTZ_OID] ?? ((x: unknown) => x);
  serializers[TIMESTAMPTZ_OID] = (x) => {
    if (x instanceof Date || (Array.isArray(x) && x.some((v) => v instanceof Date))) {
      throw new TypeError(
        'RAW_SQL_DATE_PARAM: a Date was interpolated into a raw sql template; bind it with sqlTimestamp() from db/sql-timestamp.ts',
      );
    }
    return pass(x);
  };
}
