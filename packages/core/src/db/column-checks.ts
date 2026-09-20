import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export function canonicalUuidText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
}

export function orgHandleText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`;
}

/**
 * A release's version: three dot-separated integers, or nothing at all. The shape is a constraint
 * and not a convention because `highestCutVersion` orders releases by casting the column to an
 * `int[]`, and a value this predicate would have refused makes that cast throw at read time rather
 * than at write time.
 */
export function releaseVersionText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[0-9]+[.][0-9]+[.][0-9]+$'`;
}
