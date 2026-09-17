/**
 * CHECK-constraint builders shared by `schema.ts`.
 *
 * They live here rather than inline so the reasoning a constraint needs can be written at
 * length beside it — `schema.ts` is a 3,300-line file under a frozen size budget, and a
 * constraint's why is exactly the thing that gets cut first when the budget bites.
 */

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Null, or a uuid in the one spelling Postgres itself renders: lowercase hex, hyphenated.
 *
 * cm:guard ISS-1015 — this is what lets a rollup reach a uuid-valued TEXT column by plain
 * text equality, and so by its btree index, instead of guarding a `::uuid` cast with a regex
 * that neither half of can use one. A row holding some other spelling — uppercase hex, an
 * unhyphenated uuid, a string that is no uuid at all — is not an error any surface reports:
 * it is a row every rollup over that column silently omits. Validated against all 24,085
 * `usage_records` rows on beta (2026-09-17): every one already fits, so applying it discards
 * nothing, and a database where one does not fit aborts the migration naming that row rather
 * than having it cleaned away.
 *
 * The old read-side regex `^[0-9a-fA-F-]{36}$` was never the guard it was credited with:
 * 36 hyphens pass it and fail the cast it was guarding.
 */
export function canonicalUuidText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
}

/**
 * A member handle: lowercase, 3 to 40 characters, alphanumeric with interior hyphens, or null.
 *
 * Moved out of `schema.ts` with ISS-1015 rather than for its own sake: this file was created to
 * pay that change's four lines back out of a file frozen at its size, and a second constraint of
 * exactly the same shape is the honest thing to take. The SQL and the constraint name are
 * unchanged, so the database sees nothing.
 */
export function orgHandleText(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR ${column} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`;
}
