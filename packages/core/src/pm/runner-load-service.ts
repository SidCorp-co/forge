/**
 * Per-runner in-flight load for a project.
 *
 * `forge_pm.runner_load` and `forge_pm.snapshot` each carried their own copy of
 * this query, and they had already drifted over which statuses occupy a
 * runner. That question is now `jobs/in-flight.ts`'s alone; what remains here
 * is the pairing with the runner rows and the cap.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { RUNNER_CAP_PER_RUNNER } from '../jobs/dispatch-gates.js';
import { countInFlightByRunner } from '../jobs/in-flight.js';

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

  const inFlightById = await countInFlightByRunner(runnerRows.map((r) => r.id));

  return runnerRows.map((r) => ({
    ...r,
    capacity: RUNNER_CAP_PER_RUNNER,
    inFlight: inFlightById.get(r.id) ?? 0,
  }));
}
