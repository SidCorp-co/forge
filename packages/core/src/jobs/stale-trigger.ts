/**
 * ISS-789 — end the jobs whose trigger has moved on.
 *
 * The L1b `staleTrigger` gate in `dispatch-gates.ts` stops such a job being
 * dispatched. That alone is not enough: `jobs_active_unique` is unique on
 * (issue_id, type) across `queued|dispatched|running|held`, so a job the picker
 * merely skips still blocks the replacement job for the same step forever. The
 * gate hides it; this ends it.
 *
 * Runs from `dispatch-tick.ts` before the picker. Never touches `issues.status`
 * — collapsing what an issue was waiting for is the harm this whole issue is
 * about (four anhome issues restored by hand on 2026-08-07).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { assertDispatchable, gateReasonsForQueuedJobs } from './dispatch-gates.js';

/** `jobs.failure_reason` written on a discard — the string an operator greps. */
export const STALE_TRIGGER_REASON = 'stale_trigger';

/**
 * Terminally discard every `queued` job in `projectId` whose declared trigger
 * status is no longer the issue's live status. Returns the ids actually flipped
 * (a job whose status changed under us is skipped, not retried).
 *
 * Best-effort by contract: it is called from the dispatch tick, so a failure
 * here must never stop the sweep that follows it.
 */
// cm:guard read the stale set from `gateReasonsForQueuedJobs`, never a second copy of the predicate — that reader returns the MOST SPECIFIC gate, which is what makes this conservative for free: a job that is also `issue_busy` reports `issue_busy` and is left alone, so a sibling step mid-flight can never get the job queued behind it discarded.
export async function discardStaleTriggerJobs(projectId: string): Promise<string[]> {
  const gated = await gateReasonsForQueuedJobs(projectId);
  const staleIds = [...gated.entries()]
    .filter(([, reason]) => reason === 'stale_trigger')
    .map(([jobId]) => jobId);
  if (staleIds.length === 0) return [];

  const rows = await db
    .select()
    .from(jobs)
    .where(and(inArray(jobs.id, staleIds), eq(jobs.status, 'queued')));

  const discarded: string[] = [];
  for (const job of rows) {
    // cm:guard re-read the gate through `assertDispatchable`, never a local copy of the staleness test — the batch read above and this write are separate statements, so a transition that landed between them (a human moving the issue back onto this job's trigger, a reconciler rollback) would otherwise cancel the job that had just become the right one. Going through the asserter means the re-check cannot drift from the gate it is re-checking.
    const recheck = await assertDispatchable(job.id);
    if (recheck.ok || recheck.reason !== STALE_TRIGGER_REASON) continue;

    // cm:guard `failureAction: 'terminal'` and deliberately NO `failureKind` — a trigger that moved on is not a fault of the code, the box or the provider, so every member of that taxonomy would be a false attribution; `terminal` is the field that actually says "never retry this", and it is what keeps the discard out of the retry engine pixelight `59affc88` measured at 254 attempts leaving no trace on the issue.
    const [updated] = await applyKernelTransition(db, {
      entity: 'job',
      to: 'cancelled',
      set: {
        finishedAt: new Date(),
        failureAction: 'terminal',
        failureReason: STALE_TRIGGER_REASON,
        error: `stage trigger moved on: the job's declared stageStatus is no longer the issue's status`,
      },
      where: and(eq(jobs.id, job.id), eq(jobs.status, 'queued')),
      fromStatus: 'queued',
      reason: STALE_TRIGGER_REASON,
      actor: { type: 'system' },
      source: 'stale-trigger',
    });
    if (!updated) continue;

    discarded.push(updated.id);
    // cm:why the same tail `cancelJob` runs for a queued job, minus `insertInterventionEvent` — a system discard is not an audited human intervention, and counting it as one inflates the per-issue interventions metric that is this project's north-star number
    await syncAgentSessionLifecycle(updated, 'cancelled').catch((err) =>
      logger.warn({ err, jobId: updated.id }, 'stale-trigger: session sync failed'),
    );
    roomManager.publish(projectRoom(updated.projectId), {
      event: 'job.cancelled',
      data: { jobId: updated.id, status: 'cancelled', reason: STALE_TRIGGER_REASON },
    });
  }

  if (discarded.length > 0) {
    logger.info(
      { projectId, jobIds: discarded },
      'stale-trigger: discarded queued jobs whose trigger status moved on',
    );
  }
  return discarded;
}
