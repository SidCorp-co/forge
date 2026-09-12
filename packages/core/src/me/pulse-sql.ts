import { type SQL, sql } from 'drizzle-orm';

/**
 * A parenthesised parameter list for `IN (...)` inside a raw `db.execute`.
 */
// cm:guard never `= ANY(${ids})` in a drizzle template: an interpolated JS array expands as a ROW CONSTRUCTOR ($1,$2,...), so `ANY(tuple)` is a malformed array literal and throws at Bind time. The same idiom projects/health-routes.ts and health/service.ts carry, for the same reason.
export function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}
