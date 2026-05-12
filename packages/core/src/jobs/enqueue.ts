import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { closeRun, openOneShotRun } from '../pipeline/runs.js';
import { boss } from '../queue/boss.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME } from './queue-name.js';

export interface EnqueueOptions {
  startAfterSeconds?: number;
}

export async function enqueueJob(jobId: string, opts: EnqueueOptions = {}): Promise<void> {
  await boss.send(
    JOB_QUEUE_NAME,
    { jobId },
    {
      singletonKey: jobId,
      ...(opts.startAfterSeconds !== undefined ? { startAfter: opts.startAfterSeconds } : {}),
    },
  );
}

export async function enqueuePmJob(jobId: string, opts: EnqueueOptions = {}): Promise<void> {
  await boss.send(
    PM_QUEUE_NAME,
    { jobId },
    {
      singletonKey: jobId,
      ...(opts.startAfterSeconds !== undefined ? { startAfter: opts.startAfterSeconds } : {}),
    },
  );
}

export interface CreatePmJobInput {
  projectId: string;
  createdBy: string;
  issueId?: string | null;
  payload?: Record<string, unknown>;
  startAfterSeconds?: number;
}

export type CreatePmJobResult = { jobId: string; deduped: false } | { deduped: true };

/**
 * Insert a `pm` job row and route it to the PM queue. Treats a unique-index
 * collision on `jobs_pm_per_project_unique_idx` (Epic 1, ISS-17) as
 * already-in-flight and returns `{ deduped: true }` instead of throwing.
 *
 * Producers (the PM agent spawn triggers from Epic 4) call this exclusively;
 * direct `db.insert(jobs).values({type:'pm'})` would skip the per-project
 * cap that this enforces.
 */
export async function createPmJob(input: CreatePmJobInput): Promise<CreatePmJobResult> {
  // Open the one-shot run first so the job insert below can satisfy
  // jobs.pipeline_run_id NOT NULL. On dedup or insert failure we close the
  // run with 'cancelled' so we never leak open `kind='pm'` rows.
  const run = await openOneShotRun({ projectId: input.projectId, kind: 'pm' });
  try {
    const [row] = await db
      .insert(jobs)
      .values({
        projectId: input.projectId,
        createdBy: input.createdBy,
        issueId: input.issueId ?? null,
        pipelineRunId: run.id,
        type: 'pm',
        payload: input.payload ?? {},
        status: 'queued',
      })
      .returning({ id: jobs.id });
    if (!row) throw new Error('createPmJob: insert returned no row');
    await enqueuePmJob(
      row.id,
      input.startAfterSeconds !== undefined ? { startAfterSeconds: input.startAfterSeconds } : {},
    );
    return { jobId: row.id, deduped: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.debug(
        { projectId: input.projectId },
        'createPmJob: pm job already in-flight for project, dedup',
      );
      await closeRun(run.id, 'cancelled');
      return { deduped: true };
    }
    await closeRun(run.id, 'cancelled');
    throw err;
  }
}
