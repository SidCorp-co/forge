import { db } from '../db/client.js';
import { type JobType, jobs } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { closeRun, openOneShotRun } from '../pipeline/runs.js';
import { boss } from '../queue/boss.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME } from './queue-name.js';

export interface EnqueueOptions {
  startAfterSeconds?: number;
}

export interface EnqueueJobInput {
  jobId: string;
  type: JobType;
  /** Required for issue-pipeline jobs; omit for project-only custom jobs. */
  issueId?: string | null;
}

/**
 * ISS-196 — `singletonKey` is `${issueId}:${jobType}` for issue-pipeline
 * jobs (rather than `jobId`), so two outbox workers picking up two outbox
 * rows for the same (issue, jobType) within pg-boss's singleton window
 * collapse to one queued message. Project-only jobs (no issueId) fall
 * back to `${jobId}:${jobType}` — still per-message-unique. The DB-layer
 * `jobs_active_unique` index (migration 0009) is the final guard.
 */
export async function enqueueJob(
  input: EnqueueJobInput,
  opts: EnqueueOptions = {},
): Promise<void> {
  const singletonKey = input.issueId
    ? `${input.issueId}:${input.type}`
    : `${input.jobId}:${input.type}`;
  await boss.send(
    JOB_QUEUE_NAME,
    { jobId: input.jobId },
    {
      singletonKey,
      ...(opts.startAfterSeconds !== undefined ? { startAfter: opts.startAfterSeconds } : {}),
    },
  );
}

export async function enqueuePmJob(pmJobId: string, opts: EnqueueOptions = {}): Promise<void> {
  // PM-queue uniqueness is enforced at the DB level by
  // `jobs_pm_per_project_unique_idx` (Epic 1, ISS-17); the pg-boss
  // singletonKey just needs to be globally unique per message, so using the
  // job's UUID is sufficient. Issue-pipeline jobs route through `enqueueJob`
  // above with `${issueId}:${type}` for cross-process dedup.
  await boss.send(
    PM_QUEUE_NAME,
    { jobId: pmJobId },
    {
      singletonKey: pmJobId,
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
