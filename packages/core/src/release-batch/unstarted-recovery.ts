// The way back for a batch nothing ever started.
//
// `createReleaseBatch` claims the roster and moves every issue to `releasing`
// BEFORE the job runs, and the liveness it checked was true once, at the cut.
// The only writer that reaches a stranded roster, `recoverStrandedReleasing`,
// runs on the run going terminal — and nothing made it do that. `pixelight`
// held an issue there for 16 hours.
//
// This is that trigger, and it is the second half of ISS-1080's own Rule 3:
// the claim and the move belong after the owner is real, OR they belong with a
// way back that does not wait for the run to go terminal. The claim stays where
// it is; this is the way back.
//
// It FENCES before it recovers, because a pass that read the roster first could
// be racing the box that is starting the job.

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
// cm:guard the number is deliberately LOOSE, and the asymmetry is the reason: a batch left stranded cost `pixelight` 16 hours of a roster nothing could reach, while a batch cancelled early costs a person one re-cut of a batch nothing had started. So it is set to outlast every transient a box has — a rate-limit reset, a restart, a drain, and the one core provably cannot see, which is a box declining because its own live job panes are at their bound. Core has no capacity signal and must not invent one: `runner_full` was a hold nothing enforced and was removed 2026-09-05. Tightening this to shrink the window a roster sits at `releasing` trades one defect for the opposite one.
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
// cm:guard `held_by IS NULL` and `dispatched_at IS NULL` are BOTH terms and neither is redundant against `status = 'queued'`. A held job is one a box took seconds ago and has not stamped yet. And `dispatched_at` survives a requeue: `jobs/hold.ts:buildRequeueUpdate` sets `status` and a fresh `queued_at` and deliberately does not clear it, so a release that ran, was held and was resumed is `queued` with a stamp on it. That is a batch which has already been on a box and may have merged or pushed, and it is not what this pass is for — this pass is for a batch NOTHING ever started. An aged hold has its own surface at `alarmAgedHolds`.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `prepareJobForMaster` sets `held_by` while the status stays `queued`, and `startJobForMaster` is the stamp. This query is written against that split; fusing those two on the claim side would leave this pass no window to see.
async function unstartedBatches(cutoffIso: string): Promise<UnstartedRow[]> {
  return (await db.execute<UnstartedRow>(sql`
    SELECT j.id AS job_id, j.pipeline_run_id AS run_id, j.project_id
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE j.type = 'release_batch'
      AND j.status = 'queued'
      AND j.held_by IS NULL
      AND j.dispatched_at IS NULL
      AND pr.status = 'running'
      AND j.queued_at < ${cutoffIso}
  `)) as unknown as UnstartedRow[];
}

/**
 * Make the job unstartable, or answer that somebody else got there first.
 */
// cm:guard a SYSTEM actor and never `cancelJob`. That verb is the audited manual escape hatch: it demands an `actorUserId` and writes a `job_events` intervention row, and its own guard says a defaulted actor would record a machine's act as an operator's decision — which is exactly the row the interventions-per-issue metric would then trust.
// cm:guard the WHERE repeats all three terms the selection made. The select and this write are separate statements, so the row may have been held or stamped in between; repeating them is what makes the CAS mean anything, and `applyKernelTransition` returning nothing IS the lost race.
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
// cm:guard this pass WRITES, unlike its neighbours in `inv7-alarms.ts`, and the difference is what there is to act on: an aged hold is honest and only a human can clear it, while a roster at `releasing` under a batch nothing started is a state no person and no machine can leave — the claim column is the only index onto those rows and the status admits them to nothing.
// cm:guard the wedge is not decoration. `recoverStrandedReleasing` writes a comment only when it is given an `actorUserId`, and a sweep has none, so without this the roster moves in total silence — which is this issue's own complaint wearing the fix's clothes.
export async function recoverUnstartedReleaseBatches(
  now: Date = new Date(),
): Promise<ReleaseUnstartedRecoveryResult> {
  const cutoffIso = new Date(now.getTime() - RELEASE_UNSTARTED_DEADLINE_MS).toISOString();
  const rows = await unstartedBatches(cutoffIso);
  let recovered = 0;

  for (const row of rows) {
    // cm:guard checked BEFORE the fence, not after. A run that recorded a promotion has code on production and `recoverStrandedReleasing` deliberately moves and clears nothing for it — so cancelling its job first would take the run terminal underneath a roster that must keep both its status and its claim, and an issue at `releasing` with no claim is reachable by nothing. It cannot happen through the query above, because a promotion needs a dispatched job; it is checked anyway, because the cost of being wrong here is a roster nobody can find.
    if (await runRecordedPromotion(row.run_id)) continue;

    const fenced = await fenceJob(row.job_id);
    if (!fenced) continue;

    await recoverStrandedReleasing(row.run_id, { reason: REASON });
    // cm:guard AFTER the recovery, because this is what takes the run terminal and the claim subscriber on that transition runs `recoverStrandedReleasing` again. Reversed, the subscriber would be the first reader and this pass would be racing its own cleanup; run in this order the second pass finds an empty set, which is the no-op it is built to be.
    await syncAgentSessionLifecycle(fenced, 'cancelled');
    await emitWedge(row);
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
// cm:guard its OWN queue and not a hop in `pipeline/sweeper.ts`, which is where the first draft of this put it. That file already coordinates six modules and `.arch.json` refuses a seventh, and the refusal is right: this pass is the release-batch domain's backstop and belongs beside `devices/master-reaper.ts`, `devices/run-session-reaper.ts` and `runners/stale-detector.ts`, each of which owns its own minute tick for the same reason.
// cm:guard every minute, so `RELEASE_UNSTARTED_DEADLINE_MS` is the whole of the wait a roster can suffer. A coarser schedule would add its own interval to a number chosen against a measured 16-hour strand, and nothing here is expensive: the query is indexed on `jobs.status` and answers empty on every tick with nothing to do.
export async function registerReleaseUnstartedRecovery(): Promise<void> {
  if (registered) return;
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
