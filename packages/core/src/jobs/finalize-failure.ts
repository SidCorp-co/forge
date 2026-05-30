/**
 * Shared failure-finalize path (ISS-280).
 *
 * The `/complete` and `/fail` device lifecycle handlers and the
 * `reconcileOrphanedJobs` sweeper pass all need the SAME tail once a job row
 * has been flipped to `failed`: route through verify-first auto-retry, fall
 * back to a manual-hold block when retry is not scheduled, mirror the linked
 * agent_session, broadcast, emit hooks, and re-tick dispatch so the freed
 * runner slot refills.
 *
 * Keeping this in one place is the anti-drift guarantee: a silently-reaped
 * orphan (runner died without calling `/complete`) recovers identically to a
 * job that reported its own failure, so the runner cap=1 slot is always
 * released and the pipeline never wedges (ISS-268 root cause).
 */

import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { computeHoldUntil } from '../pipeline/hold-policy.js';
import { hooks } from '../pipeline/hooks.js';
import { type FailureClassificationKind, setManualHoldBlock } from '../pipeline/manual-hold.js';
import { loadRecoveryStats } from '../pipeline/recovery-stats.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import type { RetryOutcome } from './retry.js';
import { scheduleAutoRetryWithVerify } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * Map classifier v2 failure kinds onto the narrower manual-hold UI enum.
 * Permission errors join `permanent_invalid` (operator must fix credentials,
 * no auto-retry possible). Timeout errors join `transient_network` (the
 * retry engine already eligibilised them; this branch is only reached when
 * the retry budget is exhausted or verification cancelled retry).
 */
export function mapFailureKindToClassification(
  failureKind: string | null | undefined,
): FailureClassificationKind {
  switch (failureKind) {
    case 'transient':
    case 'timeout':
      return 'transient_network';
    case 'permanent':
    case 'permission':
      return 'permanent_invalid';
    default:
      return 'unknown';
  }
}

export interface FinalizeFailedJobOptions {
  /** Human-readable failure reason; passed to the retry engine. */
  error: string;
  /** Exit code to surface on the broadcast + manual-hold evidence (if any). */
  exitCode?: number | undefined;
  /**
   * Pre-decided retry outcome. The resume-failed `abort` policy decides
   * upstream that no retry should happen ({ scheduled: false }); pass it here
   * so `finalizeFailedJob` skips `scheduleAutoRetryWithVerify`.
   */
  precomputedRetry?: RetryOutcome | undefined;
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

  if (!retry.scheduled && updated.issueId) {
    const classificationKind = mapFailureKindToClassification(updated.failureKind);
    const recoveryStats = await loadRecoveryStats(updated.issueId);
    await setManualHoldBlock({
      issueId: updated.issueId,
      context: {
        step: updated.type,
        trigger: 'job_failed',
        classification: {
          kind: classificationKind,
          reason: updated.failureReason ?? opts.error,
          evidence:
            opts.exitCode === undefined
              ? { jobId: updated.id }
              : { jobId: updated.id, exitCode: opts.exitCode },
        },
        attempts: updated.attempts,
        lastFailureAt: new Date().toISOString(),
        suggestedActions: ['resume', 'skip-step', 'close'],
        holdUntil: computeHoldUntil({
          classificationKind,
          trigger: 'job_failed',
          recoveryStats,
        }),
      },
    });
  }

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
