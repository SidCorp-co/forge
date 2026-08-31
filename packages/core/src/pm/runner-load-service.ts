/**
 * Per-runner in-flight load for a project.
 *
 * `forge_pm.runner_load` and `forge_pm.snapshot` each carried their own copy of
 * this query. They had already drifted: one ordered by type+name and named its
 * active statuses through a constant, the other was unordered and inlined the
 * same two literals — so a third status becoming "active" would have reached
 * one PM answer and not the other.
 */

import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import { RUNNER_CAP_PER_RUNNER } from '../jobs/dispatch-gates.js';

// cm:guard `held` is deliberately NOT here. It is a live job (RFC 0002) but it occupies no runner slot while it waits, so counting it as in-flight would make the PM read a runner as full and stop dispatching to it — the opposite of what `health/service.ts` needs, where the same word means "what is in flight" for an operator.
const OCCUPYING_JOB_STATUSES = ['dispatched', 'running'] as const;

export type RunnerLoad = {
  id: string;
  type: string;
  host: string | null;
  status: string;
  lastSeenAt: Date | null;
  capacity: number;
  inFlight: number;
};

/** Every runner on the project, each with the jobs currently occupying it. */
export async function readRunnerLoad(projectId: string): Promise<RunnerLoad[]> {
  const runnerRows = await db
    .select({
      id: runners.id,
      type: runners.type,
      host: runners.host,
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
    })
    .from(runners)
    .where(eq(runners.projectId, projectId))
    .orderBy(asc(runners.type), asc(runners.name));

  if (runnerRows.length === 0) return [];

  const counts = await db
    .select({ runnerId: jobs.runnerId, n: count() })
    .from(jobs)
    .where(
      and(
        inArray(
          jobs.runnerId,
          runnerRows.map((r) => r.id),
        ),
        inArray(jobs.status, [...OCCUPYING_JOB_STATUSES]),
      ),
    )
    .groupBy(jobs.runnerId);

  const inFlightById = new Map(counts.map((c) => [c.runnerId, Number(c.n)]));

  return runnerRows.map((r) => ({
    ...r,
    capacity: RUNNER_CAP_PER_RUNNER,
    inFlight: inFlightById.get(r.id) ?? 0,
  }));
}
