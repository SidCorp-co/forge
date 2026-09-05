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
// cm:guard this module must stay a LEAF — drizzle only, no `db/client.js`. The test factory reads this floor to build a device the claim will accept, and a transitive db import validates env at load time, before a harness has set any: the suite then dies at collection with "Invalid environment" and never runs.
// cm:edge lockstep -> packages/runner/Cargo.toml — it may only name a build that already EXISTS somewhere the fleet can reach: a published tag, or a version boxes are demonstrably reporting. Never one merely bumped in Cargo.toml and not yet cut — that refuses the whole fleet `runner_too_old` at once, with no upgrade available to satisfy it, and the only symptom is every project going quiet. 0.11.0 is deliberately kept here rather than raised with the 0.11.1 cut: this is a per-FEATURE floor, so it names the first build carrying `--agent` naming, and raising it to each new release would strand boxes over changes the claim does not need.
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
// cm:guard this predicate and `canNameItsAgent` are ONE decision in two languages and must refuse the same rows. The claim is the only thing enforcing the floor, and it refuses OUTRIGHT (`runner_too_old`) rather than degrading — so a query that counts a below-floor box as healthy hands the retry engine a candidate that can never take the job: the queue never reaches `all_devices_exhausted`, never holds, and burns all 30 attempts against a box structurally incapable of claiming. Measured on epodsystem 2026-09-05, the day the floor landed with a TypeScript half and no SQL half.
// cm:guard the regex gate makes NULL and free text fall to FALSE, and that direction is mandatory HERE and it is the only direction available: there is no safe degraded claim. A box that cannot name its agent must be invisible to selection outright — core holds no lesser setting to fall back to, having stopped deciding a box's job count entirely.
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
// cm:edge lockstep -> packages/core/src/jobs/queued-gates.ts — `fresh_capable_runners` must carry this floor too (via `claimCapableSql`, which its `devices` join can take directly), or the picker declares dispatchable what the selector then refuses and the job spins `queued` with no gate reason
export const CLAIM_CAPABLE_DEVICE = sql`AND EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND ${claimCapableSql('d')}
)`;
