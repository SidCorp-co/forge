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

import { and, eq, inArray, sql } from 'drizzle-orm';
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
    // cm:guard lock the queued job and its issue while re-reading the shared gate and flipping terminal — moving the issue back to the declared trigger between the re-check and the flip must leave this job queued, not cancel work that just became correct.
    const updated = await db.transaction(async (tx) => {
      const locked = await tx.execute<{ issue_id: string | null }>(sql`
        SELECT issue_id FROM jobs
        WHERE id = ${job.id} AND status = 'queued'
        FOR UPDATE
      `);
      const issueId = locked[0]?.issue_id;
      if (!locked[0]) return null;
      if (issueId) await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issueId} FOR UPDATE`);

      const recheck = await assertDispatchable(job.id, tx);
      if (recheck.ok || recheck.reason !== STALE_TRIGGER_REASON) return null;

      // cm:guard `failureAction: 'terminal'` and deliberately NO `failureKind` — a trigger that moved on is not a fault of the code, the box or the provider, so every member of that taxonomy would be a false attribution; `terminal` is the field that actually says "never retry this", and it is what keeps the discard out of the retry engine pixelight `59affc88` measured at 254 attempts leaving no trace on the issue.
      const [transitioned] = await applyKernelTransition(tx, {
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
      return transitioned ?? null;
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
