import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type jobs, projects } from '../db/schema.js';
import type { DeviceLite } from '../issues/actor-agency.js';
import { applyStatusTransition, type TransitionIssueRow } from '../issues/apply-transition.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { classifyFailure } from '../pipeline/failure-classifier.js';
import { hooks } from '../pipeline/hooks.js';
import { classifyVerdict, JOB_TYPE_ENTRY_STATUS } from '../pipeline/recovery-verifier.js';
import { closeOpenRunForIssue } from '../pipeline/runs.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { stampRunnerLimit } from '../runners/apply-runner-limit.js';
import { attributeFailureToRunner } from '../runners/attribute-failure.js';
import { detectRunnerLimit } from '../runners/limit-detect.js';
import { maybeQuarantineRunner } from '../runners/quarantine.js';
import { failReconcileRunForFailedJob } from '../skills/reconcile-service.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { finalizeJobDone, hasTerminalHandoffForAttempt } from './finalize-done.js';
import { holdAutoReleases, holdJobForReason } from './hold.js';
import type { RetryOutcome } from './retry.js';
import { scheduleAutoRetryWithVerify } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

const HOLD_WEDGE_CONTENT: Partial<
  Record<string, { title: string; summary: string; nextStep: string }>
> = {
  monthly_budget_exhausted: {
    title: 'Step held: monthly budget exhausted',
    summary:
      'This project hit its monthly spend budget, so the step is held instead of dispatching. The issue itself is untouched.',
    nextStep: 'Raise the budget or wait for the next billing cycle — the held step resumes itself.',
  },
  all_devices_exhausted: {
    title: 'Step held: every runner is rate-limited',
    summary:
      'Every online, capable runner is rate-limited or over its spend cap, so the step is held. The issue itself is untouched.',
    nextStep: 'Wait for a runner to recover or add capacity — the held step resumes itself.',
  },
  non_retryable_terminal: {
    title: 'Step held: non-retryable failure',
    summary:
      'The step failed in a way the pipeline will not retry, so it is held rather than parked. Nothing is being asked of the issue.',
    nextStep:
      'Fix the underlying cause, then move the issue on — this hold does not clear on its own.',
  },
  retry_rounds_exhausted: {
    title: 'Step held: retry budget exhausted',
    summary:
      'The step failed across every retry round. It is held, not parked: the issue stays at its stage.',
    nextStep:
      'Fix the underlying cause, then move the issue on — this hold does not clear on its own.',
  },
  verify_unavailable: {
    title: 'Step held: recovery check unavailable',
    summary:
      'The pipeline could not verify whether the work already completed, so it held the step rather than risk a wrong retry.',
    nextStep: 'No action needed — the hold re-checks within 10 minutes.',
  },
};

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
      projectCreatedBy: projects.createdBy,
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

  // activity_log.actorId has no FK; the project creator (audit
  // `projects.created_by`) is a valid stand-in for a system-initiated
  // transition (mirrors orchestrator `resolveSkipDevice`). Fall back to the
  // job creator.
  const actorId = row.projectCreatedBy ?? job.createdBy;
  const device: DeviceLite = { id: actorId, ownerId: actorId };
  const issueRow: TransitionIssueRow = {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    reopenCount: row.reopenCount,
  };

  // Verify-first recovery (issue already advanced or moved to another step's
  // territory) — the work is effectively done; leave the issue untouched.
  if (recoveredViaVerify) return;

  const reason = retry.reason ?? 'unknown';
  const heldJobId = retry.scheduled ? null : await holdJobForReason(job, reason);

  const entry = JOB_TYPE_ENTRY_STATUS[job.type];
  if (entry && row.status !== entry && classifyVerdict(row.status, job.type) === 'pending') {
    try {
      await applyStatusTransition(issueRow, entry, device, { skip: true });
    } catch (err) {
      logger.warn(
        { err, issueId: row.id, to: entry },
        'finalize-failure: entry-status revert failed',
      );
    }
  }
  if (retry.scheduled) return;

  if (heldJobId) {
    if (holdAutoReleases(job.payload, reason)) {
      logger.info({ jobId: heldJobId, reason }, 'hold: self-clearing, no wedge emitted');
      return;
    }
    const content = HOLD_WEDGE_CONTENT[reason];
    await emitPipelineWedge({
      projectId: row.projectId,
      issueId: row.id,
      hop: 'dispatch',
      entity: 'job',
      entityId: heldJobId,
      reason,
      action: 'No action needed unless this hold outlives the condition that caused it.',
      ...(content
        ? { title: content.title, summary: content.summary, nextStep: content.nextStep }
        : {}),
    });
    return;
  }

  try {
    await closeOpenRunForIssue(row.id, 'failed');
  } catch (err) {
    logger.warn({ err, issueId: row.id }, 'finalize-failure: closeOpenRunForIssue failed');
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
  if (updated.issueId && (await hasTerminalHandoffForAttempt(updated))) {
    const flipped = await finalizeJobDone(updated, 'completed_via_handoff');
    if (flipped) return { scheduled: false, reason: 'completed_via_handoff' };
    // CAS lost (a concurrent terminal write won) → fall through to normal path.
  }

  await attributeFailureToRunner(updated.runnerId, opts.error);

  await maybeQuarantineRunner(updated.runnerId, updated.projectId, updated.id, opts.error);

  const errorText = updated.error ?? '';
  const { retryAfter } = classifyFailure({
    error: errorText,
    meta: (updated.failureMeta as Record<string, unknown> | null) ?? null,
  });
  const limit = detectRunnerLimit(errorText, retryAfter);
  if (limit) {
    await stampRunnerLimit(updated.runnerId, updated.projectId, limit);
  }

  const retry: RetryOutcome =
    opts.precomputedRetry ?? (await scheduleAutoRetryWithVerify(updated, opts.error));

  const recoveredViaVerify =
    retry.reason === 'completed_via_recovery' || retry.reason === 'cancelled_stale';

  // ISS-393 — never no-op a failed job with an issueId: revert to entry-status
  // (retry path) or park at `waiting` + reap the run (no-retry path).
  await reconcileIssueStatusAfterFailure(updated, retry, recoveredViaVerify);

  if (!retry.scheduled) {
    await failReconcileRunForFailedJob(updated).catch((err) =>
      logger.warn(
        { err, jobId: updated.id, type: updated.type },
        'finalize-failure: failReconcileRunForFailedJob failed',
      ),
    );
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

  // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
  // clears, queued siblings may now classify differently).
  if (updated.issueId) {
    await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  }

  return retry;
}
