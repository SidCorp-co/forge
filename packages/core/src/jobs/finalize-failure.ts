/**
 * Shared failure-finalize path (ISS-280, reworked by ISS-393).
 *
 * The `/complete` and `/fail` device lifecycle handlers, the dispatcher's
 * adapter-dispatch failure path, and the `reconcileOrphanedJobs` /
 * stale-detector sweepers all need the SAME tail once a job row has been
 * flipped to `failed`: route through verify-first auto-retry, reconcile the
 * linked issue's status so it is NEVER stranded at the in-flight marker,
 * mirror the linked agent_session, broadcast, emit hooks, and re-tick
 * dispatch so the freed runner slot refills.
 *
 * ISS-393 — the legacy `setManualHoldBlock` fallback is gone. A failed job
 * with an issueId now resolves in exactly one of two ways (never a no-op):
 *   - retry scheduled  → revert issue.status to the stage entry-status so the
 *     issue reflects "work re-queued" instead of the misleading `in_progress`
 *     in-flight marker (the retry row itself drives re-dispatch);
 *   - no retry (budget exhausted / non-retryable / resume-abort) → park the
 *     issue at `waiting` (single human-review state) and reap the stuck
 *     `running` pipeline_run so its serial slot frees.
 * `on_hold`/`manualHold` are no longer failure targets — `on_hold` is now a
 * deliberate user pause only.
 *
 * Keeping this in one place is the anti-drift guarantee: a silently-reaped
 * orphan (runner died without calling `/complete`) recovers identically to a
 * job that reported its own failure, so the runner cap=1 slot is always
 * released and the pipeline never wedges (ISS-268 / ISS-34 root cause).
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import {
  type DeviceLite,
  type TransitionIssueRow,
  applyStatusTransition,
} from '../issues/apply-transition.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { JOB_TYPE_ENTRY_STATUS } from '../pipeline/recovery-verifier.js';
import { closeOpenRunForIssue } from '../pipeline/runs.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import type { RetryOutcome } from './retry.js';
import { scheduleAutoRetryWithVerify } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

export interface FinalizeFailedJobOptions {
  /** Human-readable failure reason; passed to the retry engine. */
  error: string;
  /** Exit code to surface on the broadcast (if any). */
  exitCode?: number | undefined;
  /**
   * Pre-decided retry outcome. The resume-failed `abort` policy decides
   * upstream that no retry should happen ({ scheduled: false }); pass it here
   * so `finalizeFailedJob` skips `scheduleAutoRetryWithVerify`.
   */
  precomputedRetry?: RetryOutcome | undefined;
}

/**
 * Reconcile the linked issue's status after a job failure so it is never left
 * stranded at the `in_progress` in-flight marker (the ISS-34 wedge). See the
 * module header for the two outcomes. No-op when the job has no issueId.
 *
 * Ordering contract: this runs AFTER `scheduleAutoRetryWithVerify` has already
 * inserted the queued retry row. The retry-scheduled revert therefore fires a
 * `transition` hook whose `considerEnqueue` finds that active job and skips —
 * no double-dispatch (ISS-393 D2).
 */
async function reconcileIssueStatusAfterFailure(
  job: JobRow,
  retry: RetryOutcome,
  recoveredViaVerify: boolean,
): Promise<void> {
  if (!job.issueId) return;

  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      ownerId: projects.ownerId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, job.issueId))
    .limit(1);
  if (!row) {
    logger.warn(
      { issueId: job.issueId },
      'finalize-failure: issue not found, skipping status reconcile',
    );
    return;
  }

  // activity_log.actorId has no FK; the project owner is a valid stand-in for
  // a system-initiated transition (mirrors orchestrator `resolveSkipDevice`).
  // Fall back to the job creator when the project has no owner.
  const actorId = row.ownerId ?? job.createdBy;
  const device: DeviceLite = { id: actorId, ownerId: actorId };
  const issueRow: TransitionIssueRow = {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    reopenCount: row.reopenCount,
  };

  if (retry.scheduled) {
    // Revert the in-flight marker back to the stage entry-status (code →
    // approved, fix → reopen, …). Skip when the issue is already at entry
    // (clarify/plan/review/test never leave their entry status mid-job).
    const entry = JOB_TYPE_ENTRY_STATUS[job.type];
    if (entry && row.status !== entry) {
      try {
        await applyStatusTransition(issueRow, entry, device, { skip: true });
      } catch (err) {
        logger.warn(
          { err, issueId: row.id, to: entry },
          'finalize-failure: entry-status revert failed',
        );
      }
    }
    return;
  }

  // Verify-first recovery (issue already advanced or moved to another step's
  // territory) — the work is effectively done; leave the issue untouched.
  if (recoveredViaVerify) return;

  // Budget exhausted / non-retryable kind / resume-abort: park the issue at
  // `waiting` for human review and reap the still-`running` pipeline_run.
  if (row.status !== 'waiting') {
    try {
      await applyStatusTransition(issueRow, 'waiting', device, { skip: true });
    } catch (err) {
      logger.warn(
        { err, issueId: row.id },
        'finalize-failure: park-to-waiting failed',
      );
    }
  }
  // Issue-kind runs are not closed by `syncAgentSessionLifecycle`
  // (`closeRunIfOneShot` only touches pm/interactive runs); close it here so
  // an exhausted issue does not leave its run `running` and wedge the serial
  // slot (CLAUDE.md orphan-hygiene — routes through cascadeCancelChildJobs).
  try {
    await closeOpenRunForIssue(row.id, 'failed');
  } catch (err) {
    logger.warn(
      { err, issueId: row.id },
      'finalize-failure: closeOpenRunForIssue failed',
    );
  }
}

/**
 * Finalize a job that has already been CAS-flipped to `failed`.
 *
 * The caller owns the `UPDATE jobs SET status='failed' … RETURNING` (so the
 * CAS-loser of a race no-ops before reaching here) and the `updated` row it
 * passes in MUST carry the persisted `failureKind`/`failureReason` if known.
 *
 * Returns the `RetryOutcome` so the HTTP handlers can echo it in their JSON
 * response; the sweeper ignores the return value.
 */
export async function finalizeFailedJob(
  updated: JobRow,
  opts: FinalizeFailedJobOptions,
): Promise<RetryOutcome> {
  const retry: RetryOutcome =
    opts.precomputedRetry ?? (await scheduleAutoRetryWithVerify(updated, opts.error));

  // A retry is skipped for two very different reasons:
  //  - genuine failure with no retry left (budget exhausted / non-retryable
  //    kind / resume-abort) → park the issue at `waiting` for an operator;
  //  - verify-first recovery: the issue ALREADY advanced past this step
  //    (`completed_via_recovery`) or moved into another step's territory
  //    (`cancelled_stale`) → the work is effectively done; touching the issue
  //    would wedge one that already recovered (ISS-280 AC2/AC4).
  const recoveredViaVerify =
    retry.reason === 'completed_via_recovery' || retry.reason === 'cancelled_stale';

  // ISS-393 — never no-op a failed job with an issueId: revert to entry-status
  // (retry path) or park at `waiting` + reap the run (no-retry path).
  await reconcileIssueStatusAfterFailure(updated, retry, recoveredViaVerify);

  // Mirror lifecycle to the linked agent_session row. ISS-101 — pass
  // retryPending so we leave the parent pipeline_run open when a retry has
  // just been scheduled; the retry shares the same run.
  await syncAgentSessionLifecycle(updated, 'failed', {
    retryPending: retry.scheduled === true,
  });

  roomManager.publish(projectRoom(updated.projectId), {
    event: 'job.failed',
    data: {
      jobId: updated.id,
      status: 'failed',
      exitCode: updated.exitCode,
      error: updated.error,
    },
  });

  // ISS-20 — emit hooks AFTER scheduleRetry so PM subscribers see the
  // populated `failureKind`.
  await hooks.emit('jobFailed', {
    jobId: updated.id,
    projectId: updated.projectId,
    issueId: updated.issueId,
    type: updated.type,
    failureKind: updated.failureKind ?? null,
    failureReason: updated.failureReason ?? null,
  });

  // ISS-40 PR-E — re-tick the project so newly-freed slots get filled.
  // Fire-and-forget; never await.
  void dispatchTickForProject(updated.projectId);

  // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
  // clears, queued siblings may now classify differently).
  if (updated.issueId) {
    await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  }

  return retry;
}
