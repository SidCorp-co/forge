// Stopping a project's runs when it is archived (ISS-1449): the runs' own cancel, run by run, the
// way a person's stop is, so each run's jobs, sessions and questions end through the one door.

import type { ActorAgency } from '@forge/contracts/permissions';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { cancelPipelineRun } from './runs-control.js';

/** The project's live runs (running or paused), with the version a release run was cut as. */
export async function liveRunsOfProject(projectId: string) {
  return db
    .select({
      id: pipelineRuns.id,
      kind: pipelineRuns.kind,
      releaseVersion: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        inArray(pipelineRuns.status, LIVE_PIPELINE_RUN_STATUSES),
      ),
    );
}

/** Cancel each live run of the project as `userId`; the ids of the runs it stopped. */
export async function stopProjectRuns(args: {
  projectId: string;
  userId: string;
  agency: ActorAgency;
}): Promise<string[]> {
  const stopped: string[] = [];
  for (const run of await liveRunsOfProject(args.projectId)) {
    const out = await cancelPipelineRun(run.id, {
      actorUserId: args.userId,
      actorAgency: args.agency,
    });
    if (out.run.status === 'cancelled') stopped.push(run.id);
  }
  return stopped;
}
