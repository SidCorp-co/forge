// A release act from an attempt that no longer holds its run is refused by name (ISS-1410).
//
// A release run is worked by one release job at a time, and a retry or a carry-on is a new job on the
// same run: an earlier attempt whose pane still stands (a false "lost its pane", a frame that never
// reached the box) acts on a run a later attempt holds, and two sessions push, tag and deploy one
// release. A job pane names its job on every call (`JOB_ACT_HEADER`, which the box sets as
// `$FORGE_JOB`), so the doors a release run records through read which attempt is acting and refuse
// one that is not the run's latest, or that ended. A call naming no job is a person's or a master's,
// and goes on as before: the header is what a job pane says of itself, never a credential.

import { JOB_ACT_HEADER } from '@forge/contracts/jobs';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { refuseRelease } from './refuse.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_PATH = `/headers/${JOB_ACT_HEADER}`;

/** One release job on a run, as the holding rule reads it. */
export interface ReleaseAttempt {
  id: string;
  status: string;
  cancellationRequested: boolean;
  /** The job's `attempts` count: 1 for a first job, one more for each retry of it. */
  attempts: number;
}

/** The job a call names, as the rule reads it: which run it is an attempt on. */
export interface NamedJob extends ReleaseAttempt {
  type: string;
  pipelineRunId: string;
}

/** Why the named attempt does not hold the run, or null where it does. */
export type AttemptReading =
  | null
  | { code: 'RELEASE_ATTEMPT_SUPERSEDED'; detail: string }
  | { code: 'RELEASE_ATTEMPT_ENDED'; detail: string }
  | { code: 'RELEASE_ATTEMPT_NOT_ON_RUN'; detail: string };

/**
 * A job read `failed` alone is not over: a runner before ISS-1351 failed live jobs on a false "lost
 * its pane" while their panes worked on (ISS-1411), so only a cancel ends an attempt that no later
 * one superseded.
 */
const CANCELLED = 'cancelled';

function named(a: ReleaseAttempt): string {
  return `job ${a.id} (attempt ${a.attempts}, ${a.status}${a.cancellationRequested ? ', cancel requested' : ''})`;
}

const STOP =
  'Push, tag and deploy nothing more from this session, call no finish or abort, and end the turn saying what you read.';

/**
 * Whether `job` holds release run `runId`, read against `attempts`, every release job on that run,
 * newest first. It holds where it is the newest and no cancel reached it: a `done` attempt is the one
 * its run's own close finished, and a `failed` one no retry superseded may be a live pane an old
 * runner failed falsely.
 */
export function attemptHolding(
  job: NamedJob,
  runId: string,
  attempts: readonly ReleaseAttempt[],
): AttemptReading {
  if (job.type !== 'release_batch' || job.pipelineRunId !== runId) {
    const holder = attempts[0];
    return {
      code: 'RELEASE_ATTEMPT_NOT_ON_RUN',
      detail: `This call names job ${job.id} in ${JOB_ACT_HEADER}, a ${job.type} job on run ${job.pipelineRunId}, and acts on release run ${runId}, which ${holder ? `${named(holder)} holds` : 'no release job of its own holds'}. A job acts only on its own run. ${STOP}`,
    };
  }
  const newest = attempts[0];
  if (newest && newest.id !== job.id) {
    const holds =
      !['failed', CANCELLED].includes(newest.status) && !newest.cancellationRequested;
    return {
      code: 'RELEASE_ATTEMPT_SUPERSEDED',
      detail: `Release run ${runId} is no longer this attempt's: ${named(job)} was superseded by ${named(newest)}, ${holds ? 'which holds the run now' : 'the latest attempt, so no attempt holds the run now'}. ${STOP}`,
    };
  }
  if (job.status === CANCELLED || job.cancellationRequested) {
    return {
      code: 'RELEASE_ATTEMPT_ENDED',
      detail: `Release run ${runId} is no longer this attempt's: ${named(job)} was cancelled, and no later attempt holds the run. ${STOP}`,
    };
  }
  return null;
}

/**
 * Refuse a release act on `runId` (or, where the act names no run, on the run of the job it names)
 * from an attempt that does not hold it. `header` is the call's `JOB_ACT_HEADER` value; absent, the
 * act is no job pane's and nothing is read.
 */
export async function assertAttemptHoldsRun(
  header: string | undefined,
  runId: string | null,
): Promise<void> {
  const said = header?.trim();
  if (!said) return;
  if (!UUID.test(said)) {
    throw refuseRelease(
      'RELEASE_ATTEMPT_UNKNOWN',
      `${JOB_ACT_HEADER} reads "${said.slice(0, 80)}", which is no job id: a job pane sends the whole id of the job it runs, as its box set it in $FORGE_JOB.`,
      HEADER_PATH,
    );
  }
  const [job] = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      pipelineRunId: jobs.pipelineRunId,
      status: jobs.status,
      cancellationRequested: jobs.cancellationRequested,
      attempts: jobs.attempts,
    })
    .from(jobs)
    .where(eq(jobs.id, said))
    .limit(1);
  if (!job) {
    throw refuseRelease(
      'RELEASE_ATTEMPT_UNKNOWN',
      `${JOB_ACT_HEADER} names job ${said}, and Forge holds no job by that id: a job pane sends the id of the job it runs, as its box set it in $FORGE_JOB.`,
      HEADER_PATH,
    );
  }
  // a deploy names no run where it is no release's: a release job's own is what it acts on
  const run = runId ?? (job.type === 'release_batch' ? job.pipelineRunId : null);
  if (!run) return;
  const reading = attemptHolding(job, run, await releaseJobsOn(run));
  if (reading) throw refuseRelease(reading.code, reading.detail, HEADER_PATH);
}

/** Every release job on `runId`, newest first. */
async function releaseJobsOn(runId: string): Promise<ReleaseAttempt[]> {
  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      cancellationRequested: jobs.cancellationRequested,
      attempts: jobs.attempts,
    })
    .from(jobs)
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(desc(jobs.queuedAt), desc(jobs.createdAt));
  return rows
    .filter((r) => r.type === 'release_batch')
    .map(({ type: _type, ...attempt }) => attempt);
}
