// Surfacing half of the L2 `blockedBy` gate: a queued job whose `blocks` parent
// can never satisfy the gate on its own.
//
// Two statuses do that, for opposite reasons. `draft` is the status the
// dispatcher does not pick up, so the blocker cannot advance. `dropped` is
// terminal and never stamps `merged_at`, so the blocker will not advance ever.
// The wait is legitimate in both cases; being silent about it is not.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
// cm:why LoopScope at its source rather than sweeper.ts's `SweepScope` alias — importing the alias made these two files a cycle in the resolved graph (type-only, so erased at runtime, but the checker cannot know that) for a name that adds nothing
import type { LoopScope } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from './wedge.js';

/**
 * Grace window before a still-queued, dependency-blocked job is treated as a
 * deadlock rather than a normal wait. Long by design: a legit blocker can take
 * a while to merge. Override with `FORGE_STALL_GRACE_MS`.
 */
// cm:guard exported and consumed by `sweeper.ts`, never the reverse — the passes there need the same window, and importing it FROM sweeper would close a require cycle whose const would read `undefined` depending on module init order
export const STALL_GRACE_MS = (() => {
  const env = Number(process.env.FORGE_STALL_GRACE_MS);
  return Number.isFinite(env) && env > 0 ? env : 45 * 60_000;
})();

export interface BlockedDependentAlarmResult {
  /** Dependents alarmed because a blocker is at `draft` or `dropped`. */
  alerted: number;
}

type BlockedRow = {
  job_id: string;
  project_id: string;
  issue_id: string;
  blocker_seq: number;
  blocker_title: string;
  blocker_status: string;
  blocker_count: number;
};

const COPY = {
  draft: {
    title: 'Blocked on an issue that is still a draft',
    tail: 'is still at `draft`. The pipeline never picks up a draft, so this wait cannot end by itself.',
    nextStep:
      'Open the blocker so it can run, or drop the dependency if the order no longer matters — this issue then dispatches by itself.',
    action: 'Open or unlink the blocking draft; no action is needed on this issue.',
  },
  dropped: {
    title: 'Blocked on an issue that was dropped',
    tail: 'was `dropped`, so it will never merge and can never satisfy the gate. This wait cannot end by itself.',
    nextStep:
      'Expire the edge (`forge_project_pm set_dependency` with `validUntil` in the past) if the work moved elsewhere, or re-point it at whichever issue absorbed it — this issue then dispatches by itself.',
    action:
      'Expire or re-point the edge onto the blocking dropped issue; no action is needed on this issue.',
  },
} as const;

/**
 * Emit one wedge per dependent whose `blocks` parent is `draft` or `dropped`.
 *
 * The gate itself is CORRECT and stays — see the guards below. Alarm only.
 */
// cm:guard do NOT "fix" this by exempting `draft` blockers from the L2 gate. Owner decision 2026-08-14: an edge pointing at a draft means the draft really must come first, so dispatching past it would ship work in the wrong order. The defect was never the wait — it was that the wait was silent, and this pass is the whole fix.
// cm:guard `dropped` was added to `issueStatuses` on 2026-08-20 and reached this gate with NO surfacing half, which is the exact hole the lockstep edge below warns about: on getcontent a consolidation dropped ISS-463 and its stale edge held ISS-455, and through ISS-455 held ISS-457, queued 53h against four idle unlimited runners with nobody notified (measured 2026-08-22). Whether the GATE should treat `dropped` as satisfied is a separate owner decision — this pass only makes the wait visible.
// cm:guard alarm ONLY, like its closed-unmerged sibling (RFC 0002 INV-5) — never write issues.status. A park here would ask a human to move the dependent back by hand once the blocker resolves, when the gate already releases it with no intervention at all.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — L2 `blockedBy` is what actually holds these jobs; if that predicate stops treating a `draft` or `dropped` blocker as unsatisfied, this pass starts alarming about jobs that are dispatching fine
export async function alarmUnrunnableBlockedDependents(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<BlockedDependentAlarmResult> {
  try {
    const cutoffIso = new Date(now.getTime() - STALL_GRACE_MS).toISOString();
    const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;

    // cm:why DISTINCT ON the issue with a blocker COUNT rather than one row per edge — brand-gateway ISS-50 is blocked by three drafts at once (ISS-51/52/53, measured 2026-08-14), and a row each would be three notifications about one stuck issue
    const rows = await db.execute<BlockedRow>(sql`
      SELECT DISTINCT ON (j.issue_id)
             j.id AS job_id, j.project_id, j.issue_id::text AS issue_id,
             p.iss_seq AS blocker_seq, p.title AS blocker_title,
             p.status AS blocker_status,
             count(*) OVER (PARTITION BY j.issue_id)::int AS blocker_count
      FROM jobs j
      JOIN pipeline_runs r ON r.id = j.pipeline_run_id
      JOIN issue_dependencies d ON d.kind = 'blocks' AND d.to_issue_id = j.issue_id
      JOIN issues p ON p.id = d.from_issue_id
      WHERE j.status = 'queued'
        AND j.type <> 'pm'
        AND j.issue_id IS NOT NULL
        AND j.queued_at < ${cutoffIso}
        AND r.status = 'running'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND p.status IN ('draft', 'dropped')
        ${projectClause}
      ORDER BY j.issue_id, p.iss_seq ASC
      LIMIT 100
    `);

    let alerted = 0;
    for (const row of rows) {
      try {
        const copy = row.blocker_status === 'dropped' ? COPY.dropped : COPY.draft;
        const others = row.blocker_count - 1;
        const alsoText = others > 0 ? ` (and ${others} other blocker${others > 1 ? 's' : ''})` : '';
        await emitPipelineWedge({
          projectId: row.project_id,
          issueId: row.issue_id,
          hop: 'dispatch',
          entity: 'job',
          entityId: row.job_id,
          reason: `blocker_${row.blocker_status}:${row.blocker_count}`,
          title: copy.title,
          summary: `ISS-${row.blocker_seq} "${row.blocker_title}"${alsoText} blocks this issue and ${copy.tail}`,
          nextStep: copy.nextStep,
          action: copy.action,
        });
        alerted++;
      } catch (err) {
        logger.warn(
          { err, issueId: row.issue_id },
          'pipeline-sweeper: blocked-dependent row failed (skipped)',
        );
      }
    }
    if (alerted > 0) {
      logger.info({ alerted }, 'pipeline-sweeper: unrunnable-blocked dependents surfaced');
    }
    return { alerted };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: alarmUnrunnableBlockedDependents failed');
    return { alerted: 0 };
  }
}
