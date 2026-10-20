/**
 * A timestamp as an API answers it: ISO 8601. A drizzle column answers a `Date`, but a raw read
 * (`db.execute`, an aggregate under `sql<…>`) answers Postgres's own text, such as
 * `2026-10-20 04:15:53.658+00`, which not every reader parses.
 */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const at = new Date(value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  if (Number.isNaN(at.getTime())) throw new Error(`"${value}" is not a timestamp`);
  return at.toISOString();
}

/** As {@link isoOrNull}, for a column that is never null. */
export function isoOf(value: Date | string): string {
  return isoOrNull(value) as string;
}
