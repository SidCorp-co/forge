// REQ-76 BC-13: a failed deploy or a rolled-back release on a yolo project raises it to standard
// (`project-config/gates.ts:raiseAfterIncident`), and only a person lowers it again. Asked from the
// two places a release goes wrong: the deploy settlement that fails a run, and a rollback Coolify
// accepted. Any other profile is left as it is.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { raiseAfterIncident } from '../project-config/index.js';

export async function raiseOnIncident(input: {
  projectId: string;
  cause: 'deploy_failed' | 'release_reverted';
  ref: string;
  why: string;
}): Promise<void> {
  const outcome = await raiseAfterIncident(input);
  if (outcome === 'raised') {
    logger.warn(input, 'gates: a yolo project was raised to standard after a release went wrong');
  } else if (outcome === 'stale') {
    // three writes in a row lost the race for the project document: said loudly, never assumed
    throw new Error(
      `gates: project ${input.projectId} could not be raised after ${input.cause} (${input.ref}): its document moved under three attempts`,
    );
  }
}

/** The run's project, for a settlement that knows only the run. */
export async function raiseOnRunIncident(
  runId: string,
  cause: 'deploy_failed' | 'release_reverted',
  why: string,
): Promise<void> {
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) throw new Error(`gates: run ${runId} settled ${cause} and is not on record`);
  await raiseOnIncident({ projectId: run.projectId, cause, ref: `run ${runId}`, why });
}
