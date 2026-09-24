import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { syncAgentSessionLifecycle } from '../jobs/agent-session-link.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { recoverStrandedReleasing, runRecordedPromotion } from './releasing-recovery.js';

/**
 * How long a release batch may wait for a box to take its job.
 */
export const RELEASE_UNSTARTED_DEADLINE_MS = (() => {
  const raw = Number(process.env.FORGE_RELEASE_UNSTARTED_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
})();

export interface ReleaseUnstartedRecoveryResult {
  /** Batches whose job was fenced and whose roster was handed back. */
  recovered: number;
}

interface UnstartedRow extends Record<string, unknown> {
  job_id: string;
  run_id: string;
  project_id: string;
}

const REASON = 'no box took this release batch before its deadline, so it never started';

/**
 * Every release batch whose job is still waiting, past the deadline.
 */
async function unstartedBatches(cutoffIso: string): Promise<UnstartedRow[]> {
  return (await db.execute<UnstartedRow>(sql`
    SELECT j.id AS job_id, j.pipeline_run_id AS run_id, j.project_id
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE j.type = 'release_batch'
      AND (j.status = 'queued' OR (j.status = 'cancelled' AND j.error = ${REASON}))
      AND j.held_by IS NULL
      AND j.dispatched_at IS NULL
      AND pr.status = 'running'
      AND j.queued_at < ${cutoffIso}
  `)) as unknown as UnstartedRow[];
}

/**
 * Make the job unstartable, or pick up a fence this pass already made.
 */
async function fenceOrResume(jobId: string): Promise<typeof jobs.$inferSelect | null> {
  const fenced = await fenceJob(jobId);
  if (fenced) return fenced;
  const [resumed] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'cancelled'), eq(jobs.error, REASON)))
    .limit(1);
  return resumed ?? null;
}

/**
 * Make the job unstartable, or answer that somebody else got there first.
 */
async function fenceJob(jobId: string): Promise<typeof jobs.$inferSelect | null> {
  const [row] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'cancelled',
    set: { finishedAt: new Date(), error: REASON },
    where: and(
      eq(jobs.id, jobId),
      eq(jobs.status, 'queued'),
      isNull(jobs.heldBy),
      isNull(jobs.dispatchedAt),
    ),
    fromStatus: 'queued',
    reason: REASON,
    actor: { type: 'system' },
    source: 'sweeper',
  });
  return row ?? null;
}

/**
 * Hand back the roster of every batch whose job outlived the deadline.
 */
export async function recoverUnstartedReleaseBatches(
  now: Date = new Date(),
): Promise<ReleaseUnstartedRecoveryResult> {
  const cutoffIso = new Date(now.getTime() - RELEASE_UNSTARTED_DEADLINE_MS).toISOString();
  const rows = await unstartedBatches(cutoffIso);
  let recovered = 0;

  for (const row of rows) {
    if (await runRecordedPromotion(row.run_id)) continue;

    const fenced = await fenceOrResume(row.job_id);
    if (!fenced) continue;

    await recoverStrandedReleasing(row.run_id, { reason: REASON });
    await emitWedge(row);
    await syncAgentSessionLifecycle(fenced, 'cancelled');
    recovered++;
  }

  if (recovered > 0) {
    logger.warn({ recovered }, 'release-batch: batches recovered from a job no box ever took');
  }
  return { recovered };
}

const RECOVERY_QUEUE = 'release-batch-unstarted-recovery';
let registered = false;

/**
 * Run the pass on a schedule of its own.
 */
export async function registerReleaseUnstartedRecovery(): Promise<void> {
  if (registered) return;
  // The release batch's background work registers as one: the finish job and its sweep with it.
  const { registerReleaseBatchFinish } = await import('./finish-job.js');
  await registerReleaseBatchFinish();
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RECOVERY_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RECOVERY_QUEUE, async () => {
    await recoverUnstartedReleaseBatches();
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RECOVERY_QUEUE, '* * * * *');
  registered = true;
}

export function resetReleaseUnstartedRecoveryForTest(): void {
  registered = false;
}

async function emitWedge(row: UnstartedRow): Promise<void> {
  await emitPipelineWedge({
    projectId: row.project_id,
    hop: 'dispatch',
    entity: 'job',
    entityId: row.job_id,
    reason: REASON,
    action:
      'Check that a runner carrying this project`s release label is online, then cut the batch again.',
    title: 'A release was cancelled because no machine picked it up',
    summary:
      'The release was prepared and then waited for a machine to run it, and none did. Every issue in it has been put back where it was, so nothing is lost and nothing is half-released.',
    nextStep:
      'Make sure the machine that does this project`s releases is switched on, then start the release again.',
  });
}
