import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export function canonicalUuidText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
}

export function orgHandleText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`;
}

// the shape `release-batch/version.ts:parseReleaseVersion` reads, so every stored value orders
export function releaseVersionText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[0-9]{1,9}[.][0-9]{1,9}[.][0-9]{1,9}(-[a-z][a-z0-9]{0,15}[.][0-9]{1,9})?$'`;
}
