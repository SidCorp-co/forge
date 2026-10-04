import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { runnersPorts } from './ports.js';

type RunnerLoad = {
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

  const inFlightById = await runnersPorts().countInFlightByRunner(runnerRows.map((r) => r.id));

  return runnerRows.map((r) => ({ ...r, inFlight: inFlightById.get(r.id) ?? 0 }));
}
