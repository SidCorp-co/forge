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
import { devices, runners } from '../db/schema.js';
import { countInFlightByRunner } from '../jobs/in-flight.js';
import { effectiveDeviceCap } from '../runners/device-cap.js';

export type RunnerLoad = {
  id: string;
  type: string;
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
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
      maxConcurrent: devices.maxConcurrent,
      agentVersion: devices.agentVersion,
    })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(eq(runners.projectId, projectId))
    .orderBy(asc(runners.type), asc(runners.name));

  if (runnerRows.length === 0) return [];

  const inFlightById = await countInFlightByRunner(runnerRows.map((r) => r.id));

  // cm:guard `capacity` is the BOX's, so two bindings of one machine report the SAME number — that is correct and must not be "fixed" by dividing it. The PM routes work on this, and a per-binding capacity would tell it a box bound to 20 projects has 20x the headroom the dispatcher will actually grant.
  return runnerRows.map(({ maxConcurrent, agentVersion, ...r }) => ({
    ...r,
    capacity: effectiveDeviceCap(maxConcurrent, agentVersion),
    inFlight: inFlightById.get(r.id) ?? 0,
  }));
}
