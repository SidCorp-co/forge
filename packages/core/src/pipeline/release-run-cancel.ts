// A release run is ended by its abort, never by a generic cancel (ISS-761). The abort records who
// ended it and why (`release-batch/abort-stamp.ts`); a run cancel, a session cancel or a job cancel
// records neither, so each refuses an unshipped release run by name and names the abort.

import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { refusePipeline } from './refuse.js';

/**
 * Refuses `RELEASE_RUN_CANCEL_USE_ABORT` where `runId` is a live release run that has not shipped;
 * `door` is the cancel asked, as a sentence names it. A run that is not a release passes.
 */
export async function refuseCancellingRelease(
  runId: string | null | undefined,
  door: string,
): Promise<void> {
  if (!runId) return;
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run?.version || run.releasedAt) return;
  if (!(LIVE_PIPELINE_RUN_STATUSES as readonly string[]).includes(run.status)) return;
  throw refusePipeline(
    'RELEASE_RUN_CANCEL_USE_ABORT',
    `Run ${runId} is release ${run.version}, and ${door} does not end a release: its abort does, recording who ended it and why. Abort it with POST /api/projects/${run.projectId}/release-batches/${runId}/abort and the body { "reason": "<why it ends>" }.`,
  );
}
