import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type jobs, projects } from '../db/schema.js';
import type { DeviceLite } from '../issues/index.js';
import {
  applyStatusTransition,
  publishPipelineHealthChanged,
  type TransitionIssueRow,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { projectRoom, roomManager } from '../lib/rooms.js';
import {
  classifyFailure,
  classifyVerdict,
  closeOpenRunForIssue,
  emitPipelineWedge,
  JOB_TYPE_ENTRY_STATUS,
} from '../pipeline/index.js';
import {
  attributeFailureToRunner,
  detectRunnerLimit,
  maybeQuarantineRunner,
  stampRunnerLimit,
} from '../runners/index.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { finalizeJobDone, hasTerminalHandoffForAttempt } from './finalize-done.js';
import { holdAutoReleases, holdJobForReason, RUN_CLOSED } from './hold.js';
import type { RetryOutcome } from './retry.js';
import { scheduleAutoRetryWithVerify } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

const HOLD_WEDGE_CONTENT: Partial<
  Record<string, { title: string; summary: string; nextStep: string }>
> = {
  all_devices_exhausted: {
    title: 'Step held: every runner is rate-limited',
    summary:
      'Every online, capable runner is rate-limited or over its spend cap, so the step is held. The issue itself is untouched.',
    nextStep:
      'This step already spent its one automatic release. Once a runner recovers, resume the held job (POST /api/jobs/:id/resume).',
  },
  non_retryable_terminal: {
    title: 'Step held: non-retryable failure',
    summary:
      'The step failed in a way the pipeline will not retry, so it is held rather than parked. Nothing is being asked of the issue.',
    nextStep:
      'Fix the underlying cause, then resume the held job (POST /api/jobs/:id/resume) — this hold does not clear on its own.',
  },
  retry_rounds_exhausted: {
    title: 'Step held: retry budget exhausted',
    summary:
      'The step failed across every retry round. It is held, not parked: the issue stays at its stage.',
    nextStep:
      'Fix the underlying cause, then resume the held job (POST /api/jobs/:id/resume) — this hold does not clear on its own.',
  },
  verify_unavailable: {
    title: 'Step held: recovery check unavailable',
    summary:
      'The pipeline could not verify whether the work already completed, so it held the step rather than risk a wrong retry.',
    nextStep:
      'This step already spent its one automatic release. Resume the held job (POST /api/jobs/:id/resume) once the check can run.',
  },
};

interface FinalizeFailedJobOptions {
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

  // A run that closed under the failure takes no successor; whoever closed it owns the issue.
  if (retry.reason === RUN_CLOSED) return;
  const reason = retry.reason ?? 'unknown';
  const hold = retry.scheduled ? null : await holdJobForReason(job, reason);
  if (hold === 'superseded' || hold === RUN_CLOSED) return;
  const heldJobId = hold?.heldId ?? null;

  const entry = JOB_TYPE_ENTRY_STATUS[job.type];
  if (entry && row.status !== entry && classifyVerdict(row.status, job.type) === 'pending') {
    try {
      await applyStatusTransition(issueRow, entry, device, {
        recovery: true,
        reason: 'job_failed_entry_revert',
      });
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
      action:
        'This hold does not release itself: resume the held job (POST /api/jobs/:id/resume) or cancel it.',
      ...(content
        ? { title: content.title, summary: content.summary, nextStep: content.nextStep }
        : {}),
    });
    return;
  }

  try {
    await closeOpenRunForIssue(row.id, 'failed', {
      code: 'job_failed',
      detail: `its job ${job.id} (${job.type}) failed with \`${reason}\` and no retry was scheduled${job.error ? `: ${job.error}` : ''}`,
    });
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
  // (retry path) or hold the job + reap the run (no-retry path).
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

  // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
  // clears, queued siblings may now classify differently).
  if (updated.issueId) {
    await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  }

  return retry;
}
