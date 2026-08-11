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
import { issues, type jobs, projects } from '../db/schema.js';
import {
  type DeviceLite,
  type TransitionIssueRow,
  applyStatusTransition,
} from '../issues/apply-transition.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { classifyFailure } from '../pipeline/failure-classifier.js';
import { hooks } from '../pipeline/hooks.js';
import { JOB_TYPE_ENTRY_STATUS, classifyVerdict } from '../pipeline/recovery-verifier.js';
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
import { dispatchTickForProject } from './dispatch-tick.js';
import { finalizeJobDone, hasTerminalHandoffForAttempt } from './finalize-done.js';
import { postParkReasonComment } from './park-comment.js';
import type { RetryOutcome } from './retry.js';
import { scheduleAutoRetryWithVerify } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

// cm:why ISS-823 review #4 — business-language wedge copy per no-retry reason; reasons absent here (e.g. cancellation_requested) fall back to emitPipelineWedge's technical hop/entity/reason/action template
const PARK_WEDGE_CONTENT: Partial<
  Record<string, { title: string; summary: string; nextStep: string }>
> = {
  monthly_budget_exhausted: {
    title: 'Pipeline paused: monthly budget exhausted',
    summary:
      'This project hit its monthly spend budget, so the pipeline stopped dispatching new work.',
    nextStep: 'Raise the budget or wait for the next billing cycle, then clear the park to resume.',
  },
  all_devices_exhausted: {
    title: 'Pipeline paused: every runner is rate-limited',
    summary:
      'The job failed and every online, capable runner is currently rate-limited or over its spend cap.',
    nextStep: 'Wait for a runner to recover or add capacity, then clear the park to resume.',
  },
  non_retryable_terminal: {
    title: 'Pipeline paused: non-retryable failure',
    summary: 'The job failed in a way the pipeline will not retry automatically.',
    nextStep:
      'Review the park-reason comment, fix the underlying issue, then clear the park to resume.',
  },
  retry_rounds_exhausted: {
    title: 'Pipeline paused: retry budget exhausted',
    summary: 'The job kept failing across every retry round without succeeding.',
    nextStep:
      'Review the park-reason comment and either fix the underlying issue or clear it manually.',
  },
  verify_unavailable: {
    title: 'Pipeline paused: recovery check unavailable',
    summary:
      'The job failed and the pipeline could not verify whether the work already completed, so it stopped rather than risk a wrong retry.',
    nextStep:
      'Review the park-reason comment, confirm the issue state, then clear the park to resume.',
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

  if (retry.scheduled) {
    // Revert the in-flight marker back to the stage entry-status (code →
    // approved, fix → reopen, …). Skip when the issue is already at entry
    // (clarify/plan/review/test never leave their entry status mid-job).
    //
    // ISS-702 — a bare `row.status !== entry` check isn't enough: a later
    // step can have already parked the issue at `waiting`/`on_hold` or moved
    // it to `developed`/`tested`/`released`/`closed`/a fix-owned `reopen`
    // between when this now-stale job was dispatched and when its
    // finalize-failure runs. Only revert when the verifier still calls the
    // issue `pending` for THIS job's stage (still at entry, or at the
    // in-flight marker) — never clobber a status the verifier calls
    // `advanced`/`reverted`.
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
    return;
  }

  // Verify-first recovery (issue already advanced or moved to another step's
  // territory) — the work is effectively done; leave the issue untouched.
  if (recoveredViaVerify) return;

  // Budget exhausted / non-retryable kind / resume-abort: park the issue at
  // `waiting` for human review and reap the still-`running` pipeline_run.
  if (row.status !== 'waiting') {
    // cm:edge ordering -> packages/core/src/jobs/park-comment.ts — post the reason BEFORE the transition, so a watcher woken by the status change already finds the explanation rather than a bare `waiting`
    await postParkReasonComment({
      issueId: row.id,
      projectId: row.projectId,
      jobType: job.type,
      stageStatus: JOB_TYPE_ENTRY_STATUS[job.type] ?? null,
      reason: retry.reason ?? 'unknown',
      failureKind: job.failureKind ?? null,
      failureReason: job.failureReason ?? null,
    });
    try {
      await applyStatusTransition(issueRow, 'waiting', device, { skip: true });
    } catch (err) {
      logger.warn({ err, issueId: row.id }, 'finalize-failure: park-to-waiting failed');
    }
    const content = PARK_WEDGE_CONTENT[retry.reason ?? ''];
    await emitPipelineWedge({
      projectId: row.projectId,
      issueId: row.id,
      hop: 'dispatch',
      entity: 'job',
      entityId: job.id,
      reason: retry.reason ?? 'unknown',
      action:
        'Review the park-reason comment and either fix the underlying issue or clear it manually.',
      ...(content
        ? { title: content.title, summary: content.summary, nextStep: content.nextStep }
        : {}),
    });
  }
  // Issue-kind runs are not closed by `syncAgentSessionLifecycle`
  // (`closeRunIfOneShot` only touches pm/interactive runs); close it here so
  // an exhausted issue does not leave its run `running` and wedge the serial
  // slot (CLAUDE.md orphan-hygiene — routes through cascadeCancelChildJobs).
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
  // False-failure override (see finalize-done.ts): the runner reports `failed`
  // when it misses the Claude CLI `result` event even though the agent ran the
  // step to completion. If the agent wrote a terminal handoff for this attempt,
  // that authoritative signal beats the runner's exit detection — mark the job
  // `done` instead of retrying / parking at `waiting`. Covers both the
  // "Agent completed with errors" (null-exit) and the silent-death-after-work
  // classes. Runs BEFORE scheduleAutoRetryWithVerify so no retry is queued.
  if (updated.issueId && (await hasTerminalHandoffForAttempt(updated))) {
    const flipped = await finalizeJobDone(updated, 'completed_via_handoff');
    if (flipped) return { scheduled: false, reason: 'completed_via_handoff' };
    // CAS lost (a concurrent terminal write won) → fall through to normal path.
  }

  // cm:why ISS-806 — stamp the box BEFORE any retry decision: a retry re-targets another device, so `updated.runnerId` only names the failing box until then
  await attributeFailureToRunner(updated.runnerId, opts.error);

  // cm:why ISS-825 — MUST be awaited before the retry decision: onlineCapableDeviceIds/selectRunnerForJob read quarantinedUntil for THIS retry, same ordering contract as stampRunnerLimit below
  await maybeQuarantineRunner(updated.runnerId, updated.projectId, updated.id, opts.error);

  // cm:why retryAfter's canonical source is failureMeta (via classifyFailure below), not jobs.retryAfterAt — that column is only the retry engine's flat cooldown on the *next* attempt's row, never this failed one
  // cm:why ISS-823 review blocker — stampRunnerLimit MUST be awaited BEFORE scheduleAutoRetryWithVerify: the all_devices_exhausted check reads onlineCapableDeviceIds, which filters on rateLimitedUntil, so a fire-and-forget stamp made AFTER that read let the box that just hit the cap still count as healthy for THIS decision
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

  // cm:edge sideeffect -> packages/core/src/skills/reconcile-service.ts — reconcile/verify_skill jobs carry issueId=null (skipped above) but still need a terminal path on failure (BLOCKER M, ISS-801 review).
  // cm:why skipped when a retry is scheduled (MINOR S, ISS-801 review) — the retry clone is about to re-run the whole Master/verifier agent, so failing the run here would discard that in-flight attempt.
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
