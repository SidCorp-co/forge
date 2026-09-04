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
