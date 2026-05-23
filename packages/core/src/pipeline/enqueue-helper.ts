import { db } from '../db/client.js';
import { type JobType, jobs } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { setCurrentStep } from './runs.js';

/**
 * Thrown when the same (issueId, type) already has a queued/dispatched/
 * running job. Manual callers (`triggerPipelineStepManual`) rethrow this so
 * the HTTP layer can return 409; auto callers (`considerEnqueue`) catch it
 * and silently return.
 */
export class ActiveJobConflictError extends Error {
  constructor(
    public readonly existingJobId: string | null,
    public readonly type: JobType,
  ) {
    super(`active ${type} job already exists for this issue`);
    this.name = 'ActiveJobConflictError';
  }
}

interface InsertAndEnqueueArgs {
  projectId: string;
  issueId: string;
  pipelineRunId: string;
  createdBy: string;
  type: JobType;
  skillName: string;
  promptString: string;
  payloadExtras: Record<string, unknown>;
  /** Caller queries an existing active job in case of unique-violation so the error includes the racing jobId. */
  resolveRacingJobId?: () => Promise<string | null>;
}

/**
 * Insert a `jobs` row, link its `currentStep` on the pipeline run, and
 * enqueue it on pg-boss. On unique-violation (concurrent insert with the
 * same (issueId, type) shape) throws `ActiveJobConflictError` so callers
 * can map to either 409 (manual) or debug-log + return (auto).
 *
 * pg-boss enqueue failures are logged but NOT thrown — the jobs row is
 * persisted and the dispatcher / stuck-watcher will pick it up on retry.
 */
export async function insertAndEnqueueJob(
  args: InsertAndEnqueueArgs,
): Promise<{ jobId: string }> {
  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        pipelineRunId: args.pipelineRunId,
        createdBy: args.createdBy,
        type: args.type,
        payload: {
          skillName: args.skillName,
          promptString: args.promptString,
          ...args.payloadExtras,
        },
        status: 'queued',
      })
      .returning({ id: jobs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const racing = (await args.resolveRacingJobId?.()) ?? null;
      throw new ActiveJobConflictError(racing, args.type);
    }
    throw err;
  }
  if (!insertedId) throw new Error('jobs: insert returned no row');

  await setCurrentStep(args.pipelineRunId, args.type);

  try {
    await enqueueJob({ jobId: insertedId, issueId: args.issueId, type: args.type });
  } catch (err) {
    logger.error(
      { err, jobId: insertedId },
      'enqueue-helper: pg-boss enqueue failed; job row persisted',
    );
  }

  return { jobId: insertedId };
}
