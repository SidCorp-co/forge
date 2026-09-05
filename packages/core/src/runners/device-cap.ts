/**
 * How many jobs one box may carry, and the version floor that decides it.
 *
 * The answer is needed in two languages: TypeScript at the locked claim, SQL in
 * the picker CTE and the selector. Both halves live here so a change to one is
 * visibly a change to the other.
 */

import { sql } from 'drizzle-orm';

/** First runner release holding the repo-root lock (`daemon/repo_lock.rs`). */
// cm:guard per-FEATURE floor, never a blanket "is the runner current" check. Core deploys in one step and the fleet updates on its own clock, so a box that has not restarted yet is normal, not broken — and a box below this floor runs `workspace::refresh` on the shared root with no lock at all. Trusting it with a cap above 1 lets two jobs `merge --ff-only` one index and rewrite files an agent is mid-read on.
// cm:edge lockstep -> packages/runner/Cargo.toml — this string names a runner release; it may only rise to a version that has actually been cut and published, or every box reads as too old and the whole fleet silently falls back to cap 1
export const REPO_LOCK_MIN_RUNNER = '0.10.5';

/** First runner release whose claim carries the master's `--agent` name. */
// cm:guard this module must stay a LEAF — drizzle only, no `db/client.js`. The test factory reads this floor to build a device the claim will accept, and a transitive db import validates env at load time, before a harness has set any: the suite then dies at collection with "Invalid environment" and never runs.
// cm:edge lockstep -> packages/runner/Cargo.toml — same rule as the floor above: it may only rise to a runner release that has actually been cut, or every box reads as too old and is refused `runner_too_old`
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

const MIN_PARTS = REPO_LOCK_MIN_RUNNER.split('.').map(Number);

function atLeast(version: string | null | undefined, min: number[]): boolean {
  if (!version) return false;
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const a = parts[i] as number;
    const b = min[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The cap to enforce for a box, from its configured column and the runner build
 * that will take the job.
 */
// cm:guard an unknown or unparseable version resolves to 1, and that direction is the whole safety of it. A wrong answer that says "too old" costs throughput an operator can see; one that says "new enough" corrupts a working tree nobody is watching.
export function effectiveDeviceCap(
  configured: number | null | undefined,
  runnerVersion: string | null | undefined,
): number {
  const wanted = Math.trunc(configured ?? 1);
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  if (wanted === 1) return 1;
  return atLeast(runnerVersion, MIN_PARTS) ? wanted : 1;
}

/**
 * The same decision as a SQL expression over a `devices` row.
 *
 * `alias` is the table alias the caller gave `devices` in the enclosing query.
 */
// cm:guard this expression and `effectiveDeviceCap` MUST agree. The picker offers work on the SQL answer and the locked claim allocates on the TS one: make SQL the more generous of the two and a box below the floor is offered a job the claim then refuses, every tick, forever — a queue that spins with no gate reason, which is the exact failure `fresh_capable_runners` already carries three guards about.
// cm:guard the regex gate before the cast is load-bearing, not defensive noise. `agent_version` is free text a runner reports; `'nightly'::int[]` raises and takes the whole picker query down, turning one odd box into a project-wide dispatch outage. Postgres compares int arrays element-wise, which IS semver order for three parts.
export function deviceCapSql(alias: string) {
  const version = sql.raw(`${alias}.agent_version`);
  const configured = sql.raw(`${alias}.max_concurrent`);
  const floor = sql.raw(`ARRAY[${MIN_PARTS.join(',')}]`);
  return sql`CASE
    WHEN ${version} ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     AND string_to_array(${version}, '.')::int[] >= ${floor}
    THEN GREATEST(${configured}, 1)
    ELSE 1
  END`;
}

/**
 * Whether the `devices` row at `alias` is at or above `AGENT_NAMING_MIN_RUNNER`,
 * as a SQL predicate.
 */
// cm:guard this predicate and `canNameItsAgent` are ONE decision in two languages and must refuse the same rows. The claim is the only thing enforcing the floor, and it refuses OUTRIGHT (`runner_too_old`) rather than degrading — so a query that counts a below-floor box as healthy hands the retry engine a candidate that can never take the job: the queue never reaches `all_devices_exhausted`, never holds, and burns all 30 attempts against a box structurally incapable of claiming. Measured on epodsystem 2026-09-05, the day the floor landed with a TypeScript half and no SQL half.
// cm:guard the regex gate makes NULL and free text fall to FALSE, and that direction is mandatory HERE though it is the opposite of `deviceCapSql`, which resolves the unknown to a working cap 1. There is no safe degraded claim: a box that cannot name its agent must be invisible to selection, not merely capped.
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
