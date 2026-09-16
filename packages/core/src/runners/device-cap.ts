/**
 * The runner-build floor a box must clear before its claim is accepted, in the
 * two languages that ask: TypeScript at the locked claim, SQL in the gate CTE.
 * Both halves live here so a change to one is visibly a change to the other.
 *
 * How many jobs a box may carry is NOT decided here, or anywhere in core — the
 * runner owns that, and `devices/claim.ts` carries the guard saying why.
 */

import { sql } from 'drizzle-orm';

/** First runner release whose claim carries the master's `--agent` name. */
export const AGENT_NAMING_MIN_RUNNER = '0.11.0';

/** Whether a reported runner version is at or above `min` (`a.b.c`). */
export function atLeastVersion(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/**
 * Whether the `devices` row at `alias` is at or above `AGENT_NAMING_MIN_RUNNER`,
 * as a SQL predicate.
 */
export function claimCapableSql(alias: string) {
  const version = sql.raw(`${alias}.agent_version`);
  const floor = sql.raw(`ARRAY[${AGENT_NAMING_MIN_RUNNER.split('.').join(',')}]`);
  return sql`${version} ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND string_to_array(${version}, '.')::int[] >= ${floor}`;
}

/**
 * The same floor as an `AND` fragment for a query that has no `devices` join,
 * written against a bare `device_id` so it resolves whether the enclosing query
 * aliases `runners` or not — the same shape as `NOT_DISABLED_DEVICE`.
 */
export const CLAIM_CAPABLE_DEVICE = sql`AND EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND ${claimCapableSql('d')}
)`;
