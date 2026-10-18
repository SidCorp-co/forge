/**
 * A person retries a failed job (ISS-1229 r16). The project page's "Approve & retry" only opened the
 * issue: no route let a person retry a job that failed for good. `resumeHeldJob` takes a held job
 * only, and the session retry offers the issue to a master rather than retrying the job. This one
 * admits the failed job again as a fresh queued row that names the one it retries, audited on the
 * failed row, so the failure leaves the reader's list because something retried it.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { issues, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import {
  ISSUE_RESOLVED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  statusLabel,
} from '../issues/status-sets.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { admitIssueJob, admitJob, RunClosedToJobs } from './admit.js';
import { HOLD_PAYLOAD_KEY } from './hold.js';
import { insertInterventionEvent } from './intervention-event.js';
import { AUTO_RETRY_PAYLOAD_KEY } from './retry.js';

export type JobRetryRefusal =
  | 'NOT_FOUND'
  | 'NOT_FAILED'
  | 'ALREADY_RETRIED'
  | 'ISSUE_RESOLVED'
  | 'ISSUE_ARCHIVED'
  | 'ALREADY_ACTIVE'
  | 'RUN_CLOSED';

export class JobRetryError extends Error {
  constructor(
    public readonly code: JobRetryRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'JobRetryError';
  }
}

export interface RetryFailedJobOptions {
  actorUserId: string;
  reason: string;
  source: 'rest' | 'mcp';
}

export interface RetryFailedJobResult {
  /** The new, queued job. */
  jobId: string;
  /** The failed job it retries. */
  retryOf: string;
  status: 'queued';
}

/** An issue there is nothing left to do for: shipped, closed or dropped. */
const FINISHED = [...new Set([...ISSUE_RESOLVED_STATUSES, ...ISSUE_TERMINAL_STATUSES])];

/** Postgres' unique-violation code: `jobs_active_unique` holds one live job per issue and type. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * Queue a failed job again. Refused by name where the job is not failed, was already retried, ran
 * for an issue that is finished or archived, has a live job of its kind on its issue, or ran in a run that is
 * closed and has no issue to open one on.
 */
export async function retryFailedJob(
  jobId: string,
  opts: RetryFailedJobOptions,
): Promise<RetryFailedJobResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new JobRetryError('NOT_FOUND', 'job not found');
  if (job.status !== 'failed') {
    throw new JobRetryError(
      'NOT_FAILED',
      'only a failed job is retried, and this one has not failed: a held job is resumed, a live one is left to finish',
    );
  }
  const [successor] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.retryOf, job.id))
    .limit(1);
  if (successor) {
    throw new JobRetryError(
      'ALREADY_RETRIED',
      `job was already retried as ${successor.id}; that job is the one to follow`,
    );
  }
  if (job.issueId) {
    // The one issue the job ran for, read by id, archived or not: an archived one is refused by name.
    const [issue] = await db
      .select({ status: issues.status, archivedAt: issues.archivedAt })
      .from(issues)
      .where(eq(issues.id, job.issueId))
      .limit(1);
    if (issue && FINISHED.includes(issue.status)) {
      throw new JobRetryError(
        'ISSUE_RESOLVED',
        `the issue this job ran for is at ${statusLabel(issue.status)}, so there is nothing to retry it for`,
      );
    }
    if (issue?.archivedAt) {
      throw new JobRetryError(
        'ISSUE_ARCHIVED',
        'the issue this job ran for is archived; unarchive it to retry the job',
      );
    }
  }

  const {
    [AUTO_RETRY_PAYLOAD_KEY]: _spentRotation,
    [HOLD_PAYLOAD_KEY]: _spentHold,
    ...payload
  } = (job.payload ?? {}) as Record<string, unknown>;
  const values = {
    projectId: job.projectId,
    createdBy: job.createdBy,
    type: job.type,
    payload,
    modelTier: job.modelTier,
    status: 'queued' as const,
    attempts: job.attempts + 1,
    retryOf: job.id,
  };

  let created: { id: string; issueId: string | null };
  try {
    created = await withKernelMarker(db, async (tx) => {
      const row = job.issueId
        ? await admitIssueJob(tx, { ...values, issueId: job.issueId })
        : await admitJob(tx, { ...values, issueId: null, pipelineRunId: job.pipelineRunId });
      await insertInterventionEvent(tx, {
        ...opts,
        jobId: job.id,
        issueId: job.issueId,
        previousStatus: 'failed',
        action: 'retry',
      });
      return row;
    });
  } catch (err) {
    if (err instanceof RunClosedToJobs) {
      throw new JobRetryError(
        'RUN_CLOSED',
        `${err.message}, and the job ran for no issue to open a run on`,
      );
    }
    if (isUniqueViolation(err)) {
      throw new JobRetryError(
        'ALREADY_ACTIVE',
        `a ${job.type} job is already queued or running on this issue; that one is its retry`,
      );
    }
    throw err;
  }

  logger.info(
    { jobId: created.id, retryOf: job.id, issueId: job.issueId },
    'retry: failed job re-queued by a person',
  );

  roomManager.publish(projectRoom(job.projectId), {
    event: 'job.retried',
    data: { jobId: created.id, retryOf: job.id, status: 'queued' },
  });
  if (job.issueId) await publishPipelineHealthChanged(job.projectId, [job.issueId]);

  return { jobId: created.id, retryOf: job.id, status: 'queued' };
}
