// What a finish reads before it closes anything. No outbound request, so a door may call it inline.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { abortedError, batchAborted } from './abort-stamp.js';
import { type CloseVerification, finishVerification, resolveReleaseChannels } from './channel.js';
import { ReleaseVersionMissingError } from './errors.js';

export type ReleaseRunRow = {
  projectId: string;
  metadata: unknown;
  status: PipelineRunStatus;
  releaseVersion: string | null;
};

/** The run a finish is about, or `undefined` when there is no row under that id. */
export async function readReleaseRun(runId: string): Promise<ReleaseRunRow | undefined> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      status: pipelineRuns.status,
      releaseVersion: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run;
}

/** Every refusal a finish can decide from the database alone, and how the release will be proved. */
export async function assertFinishable(
  runId: string,
  run: ReleaseRunRow,
): Promise<CloseVerification> {
  if (batchAborted(run)) throw await abortedError(runId);
  // Without a version nothing can name WHICH release carried these issues.
  if (!run.releaseVersion) throw new ReleaseVersionMissingError(runId);

  return finishVerification(await resolveReleaseChannels(run.projectId));
}
