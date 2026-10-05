import { type SQL, sql } from 'drizzle-orm';

/** The rows of a raw `db.execute`, typed by the caller. */
export const rowsOf = <T>(result: unknown): T[] => [...(result as Iterable<T>)];

/** A comma-joined parameter list for `IN (...)` inside a raw `db.execute`. */
export function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}
