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

/**
 * `ids` as one `uuid[]` parameter, for `= ANY(...)` or `IN (SELECT unnest(...))` in a raw statement:
 * a list of a thousand ids stays one parameter, so building the statement and planning it do not
 * grow with the list (an `IN (...)` of `idList` is a parameter and a plan entry per id).
 */
export function uuidArray(ids: readonly string[]): SQL {
  return sql`${sql.param([...ids])}::uuid[]`;
}
