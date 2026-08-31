/**
 * How many jobs are occupying a runner right now.
 *
 * Three places counted this independently — the PM's runner-load report, the
 * digest it primes a decision turn with, and the ops health snapshot — and
 * they had begun to disagree about which statuses count.
 */

import { and, count, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

// cm:guard `held` is deliberately absent, and `queued` too. Both are live jobs (RFC 0002) but neither holds a runner slot while it waits, so counting them makes a free runner read as full and dispatch rotates away from a box that could take work. `health/service.ts` uses a WIDER set on purpose — there the question is "what is in flight for an operator", not "what is this runner carrying".
export const OCCUPYING_JOB_STATUSES = ['dispatched', 'running'] as const;

/** Occupying-job counts keyed by runner id; a runner with none is absent. */
export async function countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>> {
  if (runnerIds.length === 0) return new Map();

  const rows = await db
    .select({ runnerId: jobs.runnerId, n: count() })
    .from(jobs)
    .where(
      and(
        inArray(jobs.runnerId, runnerIds),
        inArray(jobs.status, [...OCCUPYING_JOB_STATUSES]),
        isNotNull(jobs.runnerId),
      ),
    )
    .groupBy(jobs.runnerId);

  return new Map(
    rows
      .filter((r): r is { runnerId: string; n: number } => r.runnerId !== null)
      .map((r) => [r.runnerId, Number(r.n)]),
  );
}
