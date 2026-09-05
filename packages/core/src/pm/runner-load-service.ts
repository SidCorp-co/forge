/**
 * Per-runner in-flight load for a project.
 *
 * `forge_pm.runner_load` and `forge_pm.snapshot` each carried their own copy of
 * this query, and they had already drifted over which statuses occupy a
 * runner. That question is now `jobs/in-flight.ts`'s alone; what remains here
 * is the pairing with the runner rows.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { countInFlightByRunner } from '../jobs/in-flight.js';

export type RunnerLoad = {
  id: string;
  type: string;
  status: string;
  lastSeenAt: Date | null;
  inFlight: number;
};

/** Every runner on the project, each with the jobs currently occupying it. */
export async function readRunnerLoad(projectId: string): Promise<RunnerLoad[]> {
  const runnerRows = await db
    .select({
      id: runners.id,
      type: runners.type,
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
    })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(eq(runners.projectId, projectId))
    .orderBy(asc(runners.type), asc(runners.name));

  if (runnerRows.length === 0) return [];

  const inFlightById = await countInFlightByRunner(runnerRows.map((r) => r.id));

  // cm:guard `inFlight` is a raw count and must stay one — no capacity, no headroom, no "slots free". Core enforces no ceiling since the master began claiming from the pool, so any number derived here would be a limit nothing applies; the reader concludes, this does not conclude for it. Same rule as `devices/load.ts`.
  return runnerRows.map((r) => ({ ...r, inFlight: inFlightById.get(r.id) ?? 0 }));
}
