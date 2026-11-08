// A production deploy a person confirmed carries its release run on (ISS-1096): the run waited open
// on that person (`coolify-prod-gate.ts:awaitsProdConfirm` keeps every sweep off it), the confirm
// queued the deploy, and the release is still the agent's to finish under the version it was cut
// with. The release job that asked is told in its own pane where it still runs, as an approval's
// decision is (`approval-wake.ts`); where it stopped, a release job is queued on the same run, so a
// confirm pressed later ships that run and never needs a re-cut.

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { requestSessionSend } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { jobs, pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import {
  insertAndEnqueueJob,
  RELEASE_DEPLOY_IN_FLIGHT_STEP,
  setCurrentStep,
} from '../pipeline/index.js';
import { releaseRunSession } from './approval-wake.js';
import { RELEASE_BATCH_SKILL, releaseBatchPath } from './plan.js';

/** How the confirmed run was carried on: told in its pane, a job already waiting, one queued, or none could be. */
export type ResumeOutcome = 'told' | 'job_waiting' | 'job_queued' | 'job_refused' | 'no_job';

/** What the release run reads once its production deploy was confirmed: carry on, never re-cut. */
export function confirmedMessage(
  projectId: string,
  runId: string,
  version: string | null,
  confirmedBy: string,
): string {
  const path = `/api/${releaseBatchPath(projectId, runId)}`;
  return `The production deploy of release ${version ?? runId} was CONFIRMED by ${confirmedBy}, and Forge queued it on release run ${runId}. Carry the release on from GET ${path}/state: its deploy is in flight, so wait for it, verify it and finish under version ${version ?? 'it was cut with'}. Never re-cut or abort it for the wait it was in.`;
}

/**
 * Carry release run `runId` on after its production deploy was confirmed by `confirmedBy` (a name).
 * A run that is no release batch, or already ended, is left as it is.
 */
export async function resumeConfirmedRelease(
  runId: string,
  confirmedBy: string,
): Promise<ResumeOutcome> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run || run.status !== 'running') return 'no_job';
  const body = confirmedMessage(run.projectId, runId, run.version, confirmedBy);
  const sessionId = await releaseRunSession(runId);
  if (sessionId) {
    await requestSessionSend({
      agentSessionId: sessionId,
      kind: 'answer',
      intentId: `${runId}:prod-confirm`,
      body,
    });
    return 'told';
  }
  const [last] = await db
    .select({ status: jobs.status, payload: jobs.payload, createdBy: jobs.createdBy })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), eq(jobs.type, 'release_batch')))
    .orderBy(desc(jobs.queuedAt))
    .limit(1);
  if (!last) return 'no_job';
  const [waiting] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.pipelineRunId, runId),
        eq(jobs.type, 'release_batch'),
        inArray(jobs.status, [...LIVE_JOB_STATUSES]),
      ),
    )
    .limit(1);
  if (waiting) return 'job_waiting';
  const { skillName, promptString, ...extras } = (last.payload ?? {}) as Record<string, unknown>;
  try {
    await insertAndEnqueueJob({
      projectId: run.projectId,
      issueId: null,
      pipelineRunId: runId,
      createdBy: last.createdBy,
      type: 'release_batch',
      skillName: typeof skillName === 'string' ? skillName : RELEASE_BATCH_SKILL,
      promptString: `${body}\n\n${typeof promptString === 'string' ? promptString : ''}`.trim(),
      payloadExtras: extras,
    });
  } catch (err) {
    if (!isRefusal(err, 'ACTIVE_JOB_CONFLICT')) throw err;
    logger.warn(
      { runId, projectId: run.projectId },
      'release confirm: another release job holds the slot, so this run waits for the next one to carry it on',
    );
    return 'job_refused';
  }
  // the queued job named its own step; the deploy the confirm queued is what the run is doing
  await setCurrentStep(runId, RELEASE_DEPLOY_IN_FLIGHT_STEP);
  return 'job_queued';
}
