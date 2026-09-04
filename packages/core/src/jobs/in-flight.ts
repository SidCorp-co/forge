/**
 * How many jobs are occupying a runner right now.
 *
 * Four places counted this independently — the PM's runner-load report, the
 * digest it primes a decision turn with, the ops health snapshot and the
 * runner list — and a fifth, `countInFlightForRunner` in `dispatch-gates.ts`,
 * answered it for the dispatcher with a filter none of the other four had.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// cm:guard `held` is deliberately absent, and `queued` too. Both are live jobs (RFC 0002) but neither holds a runner slot while it waits, so counting them makes a free runner read as full and dispatch rotates away from a box that could take work. `health/service.ts` counts a WIDER set on purpose — there the question is "what is in flight for an operator", not "what is this runner carrying".
export const OCCUPYING_JOB_STATUSES = ['dispatched', 'running'] as const;

// cm:guard the parent-run filter is NOT optional and NOT a reporting nicety: ISS-258. A job whose `pipeline_run` is already terminal is an orphan that holds no cap slot, and `countInFlightForRunner` — the gate that actually allocates the slot — has excluded them since the Forge Dev 2026-05-27 stall. A report that counts them says a runner is full that the dispatcher will happily fill, and the PM then routes work away from a healthy box on the strength of a job nobody is running. `pr.id IS NULL` keeps jobs with no parent counted.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — `countInFlightForRunner` answers this same question for one runner and MUST keep the same predicate; a clause here and not there puts the number an operator reads back out of step with the number that decides dispatch
const OCCUPYING_JOBS_FOR = (runnerFilter: ReturnType<typeof sql>) => sql`
  SELECT j.runner_id, COUNT(*)::int AS n
  FROM jobs j
  LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
  WHERE ${runnerFilter}
    AND j.status IN ('dispatched', 'running')
    AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
  GROUP BY j.runner_id
`;

/** Occupying-job counts keyed by runner id; a runner with none is absent. */
export async function countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>> {
  if (runnerIds.length === 0) return new Map();

  const idList = sql.join(
    runnerIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{ runner_id: string | null; n: number | string }>(
    OCCUPYING_JOBS_FOR(sql`j.runner_id IN (${idList})`),
  );

  return new Map(
    rows.filter((r) => r.runner_id !== null).map((r) => [r.runner_id as string, Number(r.n)]),
  );
}

/** The same count for a single runner. Per BINDING — a reporting number. */
export async function countInFlightForOneRunner(runnerId: string): Promise<number> {
  const rows = await db.execute<{ n: number | string }>(
    OCCUPYING_JOBS_FOR(sql`j.runner_id = ${runnerId}`),
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The same count for a whole BOX, across every project it serves.
 */
// cm:guard this, not the per-runner count, is what a concurrency cap must be compared against. The action a cap restrains is spawning a Claude process, and that process consumes the DEVICE — one box bound to N projects carrying one job each is at N, not at 1 N times. dev1 holds 20 bindings, so a per-binding count under a per-device cap would authorise 20x the intended concurrency, and every gate would read as if it were holding.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts#RUNNER_CAP_PER_RUNNER — cap and count are one decision in two files; a cap that moves to the device while the count stays on the binding is not a smaller version of this change, it is the multiplied one
export async function countInFlightForDevice(deviceId: string): Promise<number> {
  const rows = await db.execute<{ n: number | string }>(
    sql`
      SELECT COUNT(*)::int AS n
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      WHERE j.device_id = ${deviceId}
        AND j.status IN ('dispatched', 'running')
        AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
    `,
  );
  return Number(rows[0]?.n ?? 0);
}
