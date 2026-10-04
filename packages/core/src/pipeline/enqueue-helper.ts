import { db } from '../db/client.js';
import type { JobType } from '../db/schema.js';
import { insertJobRow } from '../jobs/index.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { wakeMastersForProject } from '../ws/master-wake.js';
import { AUTONOMOUS_ENTRY_STATUS } from './autonomous-mode.js';
import { refusePipeline } from './refuse.js';
import { setCurrentStep } from './runs.js';

interface InsertAndEnqueueArgs {
  projectId: string;
  /** NULL for issue-less one-shot jobs (e.g. `smoke` canaries on a 'system'
   *  run, ISS-455). The active-job unique index is per (issueId, type), so
   *  null-issue callers must dedupe themselves. */
  issueId: string | null;
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
 * Insert a queued `jobs` row the pool will offer, link its `currentStep` on the
 * run, and wake the project's masters. A unique-violation on (issueId, type)
 * is refused `ACTIVE_JOB_CONFLICT`.
 */
export async function insertAndEnqueueJob(args: InsertAndEnqueueArgs): Promise<{ jobId: string }> {
  let insertedId: string | null = null;
  try {
    const inserted = await insertJobRow(db, {
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
    });
    insertedId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const racing = (await args.resolveRacingJobId?.()) ?? null;
      throw refusePipeline(
        'ACTIVE_JOB_CONFLICT',
        `an active ${args.type} job already exists for this issue${racing ? ` (job ${racing})` : ''}; it finishes or is cancelled before another is queued`,
      );
    }
    throw err;
  }
  if (!insertedId) throw new Error('jobs: insert returned no row');

  await setCurrentStep(args.pipelineRunId, args.type);

  await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: AUTONOMOUS_ENTRY_STATUS,
  });

  return { jobId: insertedId };
}
