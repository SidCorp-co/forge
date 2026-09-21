import { type SQL, sql } from 'drizzle-orm';

/**
 * A parenthesised parameter list for `IN (...)` inside a raw `db.execute`.
 */
export function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}
