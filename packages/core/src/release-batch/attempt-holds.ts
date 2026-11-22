// A release act from an attempt that no longer holds its run is refused by name (ISS-1410).
//
// A release run is worked by one release job at a time, and a retry or a carry-on is a new job on the
// same run: an earlier attempt whose pane still stands (a false "lost its pane", a frame that never
// reached the box) acts on a run a later attempt holds, and two sessions push, tag and deploy one
// release. A job pane names its job on every call (`JOB_ACT_HEADER`, which the box sets as
// `$FORGE_JOB`), so the doors a release run records through read which attempt is acting and refuse
// one a later started attempt superseded, or that ended. A call naming no job is a person's or a
// master's, and goes on as before: the header is what a job pane says of itself, never a credential.
// Only a retry that a box took supersedes (ISS-1418): one queued, held back behind the earlier pane or
// cancelled before it started never ran, and the live earlier attempt still holds the run.

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
  /** When a box took the job (`queued → dispatched`); null for one no box ever started. */
  dispatchedAt: Date | null;
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

/**
 * Whether a started attempt that is its run's holder still holds it: only a cancel ends one, never
 * `failed` alone. Every text naming a holder reads this, so none tells a reader that nothing works a
 * run the guard still lets an attempt act on (ISS-1418).
 */
const holds = (a: ReleaseAttempt): boolean => a.status !== CANCELLED && !a.cancellationRequested;

function named(a: ReleaseAttempt): string {
  return `job ${a.id} (attempt ${a.attempts}, ${a.status}${a.cancellationRequested ? ', cancel requested' : ''})`;
}

const STOP =
  'Push, tag and deploy nothing more from this session, call no finish or abort, and end the turn saying what you read.';

/**
 * A box took the attempt: the stamp that moves it `queued → dispatched` (`jobs/master-holds.ts:
 * dispatchHeldJob`). A retry queued, held by a master that never stamped it, held back by its box
 * while the earlier pane stands, or cancelled before any of that, has none.
 */
const started = (a: ReleaseAttempt): boolean => a.dispatchedAt !== null;

/**
 * Whether `job` holds release run `runId`, read against `attempts`, every release job on that run,
 * newest first. The holder is the newest attempt that started, or `job` itself where no attempt newer
 * than it did. It holds where it is that holder and no cancel reached it: a `done` attempt is the one
 * its run's own close finished, and a `failed` one no started retry superseded may be a live pane an
 * old runner failed falsely.
 */
export function attemptHolding(
  job: NamedJob,
  runId: string,
  attempts: readonly ReleaseAttempt[],
): AttemptReading {
  if (job.type !== 'release_batch' || job.pipelineRunId !== runId) {
    const holder = attempts.find(started);
    return {
      code: 'RELEASE_ATTEMPT_NOT_ON_RUN',
      detail: `This call names job ${job.id} in ${JOB_ACT_HEADER}, a ${job.type} job on run ${job.pipelineRunId}, and acts on release run ${runId}, which ${holder && holds(holder) ? `${named(holder)} holds` : 'no release job of its own holds'}. A job acts only on its own run. ${STOP}`,
    };
  }
  const holder = attempts.find((a) => a.id === job.id || started(a));
  if (holder && holder.id !== job.id) {
    return {
      code: 'RELEASE_ATTEMPT_SUPERSEDED',
      detail: `Release run ${runId} is no longer this attempt's: ${named(job)} was superseded by ${named(holder)}, ${holds(holder) ? 'which holds the run now and may still be working it' : 'the latest attempt a box took, so no attempt holds the run now'}. ${STOP}`,
    };
  }
  if (!holds(job)) {
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
      dispatchedAt: jobs.dispatchedAt,
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
      dispatchedAt: jobs.dispatchedAt,
    })
    .from(jobs)
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(desc(jobs.queuedAt), desc(jobs.createdAt));
  return rows
    .filter((r) => r.type === 'release_batch')
    .map(({ type: _type, ...attempt }) => attempt);
}
