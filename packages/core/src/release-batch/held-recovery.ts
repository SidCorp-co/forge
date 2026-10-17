// A release batch whose job is held, with nothing that will send it, keeps its run `running` and
// its roster at Releasing for ever: the releasing sweep counts a running run as live, the silent
// recovery reads only a job a box took, and the unstarted one only a queued job (ISS-1421 r4). This
// pass reads the held one. A hold whose reason does not clear by itself, or one that has outlived
// the deadline a release may wait for a box, is fenced and the roster handed back the way the
// unstarted recovery does. A hold on a decision is a question a person owes on the issue, and it
// waits for the answer however long that takes.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { syncAgentSessionLifecycle } from '../jobs/agent-session-link.js';
import { AUTO_RELEASE_REASONS, HOLD_PAYLOAD_KEY } from '../jobs/hold.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { AWAITING_DECISION, DECISION_KEY } from './decision-state.js';
import { heldBecause, RELEASE_JOB_TYPE, RELEASE_UNSTARTED_DEADLINE_MS } from './job-start.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

export interface ReleaseHeldRecoveryResult {
  /** Batches whose held job was fenced and whose roster was handed back. */
  recovered: number;
}

interface HeldRow extends Record<string, unknown> {
  job_id: string;
  /** `cancelled` where this pass fenced it and the hand-back did not finish. */
  status: 'held' | 'cancelled';
  run_id: string;
  project_id: string;
  hold_reason: string | null;
  auto_release: boolean;
  held_at: string;
}

/** What the fence writes on the job, and what the state reads it back by. */
export const HELD_HANDBACK_REASON =
  'the release job was held with nothing to send it, so the release could never move';

/** The sentence each roster issue's comment opens with, naming the run in words, never its id. */
export function heldHandbackSentence(reason: string | null): string {
  return `The release run carrying this issue could never move: its job was held because ${heldBecause(reason)}, and nothing would send it again`;
}

/**
 * Every held release job under an open batch run, with what its hold says of itself, and every one
 * this pass already fenced whose run is still open, so a hand-back cut short is finished.
 *
 * A decision still owed keeps the job out; one answered (`answeredAt`, carried into the payload of
 * every later hold of that lineage) does not, and a reference in a shape not read here keeps it out.
 */
async function heldReleaseJobs(): Promise<HeldRow[]> {
  return (await db.execute<HeldRow>(sql`
    SELECT j.id AS job_id, j.status, j.pipeline_run_id AS run_id, j.project_id,
           j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'reason' AS hold_reason,
           COALESCE((j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'autoRelease')::boolean, false) AS auto_release,
           COALESCE(j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'heldAt', j.queued_at::text) AS held_at
    FROM jobs j
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.type = ${RELEASE_JOB_TYPE}
      AND (j.status = 'held' OR (j.status = 'cancelled' AND j.error = ${HELD_HANDBACK_REASON}))
      AND COALESCE(j.failure_reason, '') <> ${AWAITING_DECISION}
      AND (
        NOT (COALESCE(j.payload, '{}'::jsonb) ? ${DECISION_KEY})
        OR jsonb_typeof(j.payload -> ${DECISION_KEY} -> 'answeredAt') = 'string'
      )
      AND r.status = 'running'
      AND (r.metadata ->> 'source') = 'release-batch'
      AND r.metadata -> 'finish' IS NULL
      AND r.metadata -> 'abort' IS NULL
  `)) as unknown as HeldRow[];
}

/** Nothing will send it: its hold does not clear by itself, or it has waited past the deadline. */
export function nothingWillSend(
  row: Pick<HeldRow, 'hold_reason' | 'auto_release' | 'held_at'>,
  now: Date,
): boolean {
  const resumes =
    !!row.hold_reason && AUTO_RELEASE_REASONS.has(row.hold_reason) && row.auto_release;
  if (!resumes) return true;
  const heldAt = Date.parse(row.held_at);
  return Number.isFinite(heldAt) && now.getTime() - heldAt > RELEASE_UNSTARTED_DEADLINE_MS;
}

/** Fence the held job, or pick up the fence an earlier pass made and did not finish behind. */
async function fenceOrResume(row: HeldRow): Promise<typeof jobs.$inferSelect | null> {
  if (row.status === 'held') return fenceHeldJob(row.job_id);
  const [resumed] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, row.job_id),
        eq(jobs.status, 'cancelled'),
        eq(jobs.error, HELD_HANDBACK_REASON),
      ),
    )
    .limit(1);
  return resumed ?? null;
}

async function fenceHeldJob(jobId: string): Promise<typeof jobs.$inferSelect | null> {
  const [row] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'cancelled',
    set: { finishedAt: new Date(), error: HELD_HANDBACK_REASON },
    where: and(eq(jobs.id, jobId), eq(jobs.status, 'held')),
    fromStatus: 'held',
    reason: HELD_HANDBACK_REASON,
    actor: { type: 'system' },
    source: 'sweeper',
  });
  return row ?? null;
}

export async function recoverHeldReleaseBatches(
  now: Date = new Date(),
): Promise<ReleaseHeldRecoveryResult> {
  let recovered = 0;
  for (const row of await heldReleaseJobs()) {
    if (row.status === 'held' && !nothingWillSend(row, now)) continue;
    try {
      const fenced = await fenceOrResume(row);
      if (!fenced) continue;
      await recoverStrandedReleasing(row.run_id, {
        reason: heldHandbackSentence(row.hold_reason),
        comment: true,
      });
      await emitWedge(row);
      await syncAgentSessionLifecycle(fenced, 'cancelled');
      recovered++;
    } catch (err) {
      logger.error(
        { err, jobId: row.job_id, runId: row.run_id },
        'release-batch: could not hand back a batch whose job is held',
      );
    }
  }
  if (recovered > 0) {
    logger.warn({ recovered }, 'release-batch: batches recovered from a job nothing would send');
  }
  return { recovered };
}

async function emitWedge(row: HeldRow): Promise<void> {
  await emitPipelineWedge({
    projectId: row.project_id,
    hop: 'dispatch',
    entity: 'job',
    entityId: row.job_id,
    reason: HELD_HANDBACK_REASON,
    action: 'Clear what held the release job, then start the release again.',
    title: 'A release was handed back because its job was held for good',
    summary: `The release job was held because ${heldBecause(row.hold_reason)}, and nothing would have sent it again. Every issue in the release has been put back at the release gate.`,
    nextStep: 'Clear what held it, then start the release again from the release gate.',
  });
}

const RECOVERY_QUEUE = 'release-batch-held-recovery';
let registered = false;

/** Run the pass once a minute on its own queue, beside the other release recoveries. */
export async function registerReleaseHeldRecovery(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  await boss.createQueue(RECOVERY_QUEUE);
  await boss.work(RECOVERY_QUEUE, async () => {
    await recoverHeldReleaseBatches();
  });
  await boss.schedule(RECOVERY_QUEUE, '* * * * *');
  registered = true;
}

export function resetReleaseHeldRecoveryForTest(): void {
  registered = false;
}
