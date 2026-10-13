import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createSelectSchema } from 'drizzle-zod';

const cache = new WeakMap<PgTable, ReturnType<typeof createSelectSchema>>();

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * The schema of a row as the table declares it, for a handler that answers with a row. It is read
 * from the table's own columns, so a column added or retyped changes the reference with no edit
 * here, and it is named for the table so a document that returns it from fifty routes holds it once.
 *
 * A handler that answers with some of a row's columns takes `.pick()` or `.omit()` of this, and one
 * that reshapes a row writes the shape it sends: the schema describes the answer, never the row.
 */
export function tableRow<T extends PgTable>(table: T) {
  const held = cache.get(table);
  if (held) return held as ReturnType<typeof createSelectSchema<T>>;
  const schema = createSelectSchema(table).meta({ id: pascal(getTableName(table)) });
  cache.set(table, schema);
  return schema as ReturnType<typeof createSelectSchema<T>>;
}
