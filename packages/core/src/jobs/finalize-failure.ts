/**
 * Shared failure-finalize path (ISS-280, reworked by ISS-393 + RFC 0002).
 *
 * `/complete`, `/fail`, the dispatcher's adapter-dispatch failure path, and the
 * `reconcileOrphanedJobs` / stale-detector sweepers all need the SAME tail once
 * a job row is `failed`: verify-first auto-retry, reconcile the linked issue so
 * it is NEVER stranded at the in-flight marker, mirror the agent_session,
 * broadcast, emit hooks, re-tick dispatch so the freed runner slot refills. One
 * place is the anti-drift guarantee — a silently-reaped orphan (runner died
 * without calling `/complete`) recovers identically to a job that reported its
 * own failure, so the cap=1 slot is always released (ISS-268 / ISS-34 root cause).
 *
 * A failed job with an issueId ALWAYS reverts `issues.status` to the stage
 * entry-status; `on_hold`/`manualHold`/`waiting` are no longer failure targets.
 * What differs is which JOB row carries the wait: a scheduled retry row; a
 * `held` successor (`jobs/hold.ts`) when the reason is mechanical, the run
 * staying open because a held job holds no slot; or nothing at all for a
 * conclusion (`cancellation_requested`, `completed_via_*`) — then it closes.
 */

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

// cm:guard every key here MUST also be in `HOLD_REASONS` (jobs/hold.ts) and the copy must say the work RESUMES BY ITSELF where it does — this text is the operator's only notification for a hold, and copy that asks them to "clear the park" re-teaches the intervention the hold exists to remove
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

  // Verify-first recovery (issue already advanced or moved to another step's
  // territory) — the work is effectively done; leave the issue untouched.
  if (recoveredViaVerify) return;

  const reason = retry.reason ?? 'unknown';
  const heldJobId = retry.scheduled ? null : await holdJobForReason(job, reason);

  // cm:guard this revert is the ONLY issues.status write left on the failure path (RFC 0002 INV-1/INV-2) — re-adding a `waiting` write here restores the exact lie the RFC deleted: a board saying a human is needed when nothing is being asked
  // cm:guard keep the `classifyVerdict === 'pending'` arm (ISS-702) — a bare `row.status !== entry` test also fires for an issue a LATER step already moved to on_hold/developed/tested/released/closed, and reverting then drags a finished issue back to its stage entry because this job's finalize ran late
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
    // cm:guard a hold that RELEASES ITSELF must not notify here — `releaseHeldJobs` re-queues it the moment its condition clears, so the notification asks for nothing (its own action text read "No action needed unless this hold outlives the condition that caused it"). `alarmAgedHolds` is the escalation for one that outlives it, at 6h, which is the only point a human learns anything. Measured forge-beta 2026-08-14: 721 unresolved `pipeline_wedge` rows, the bulk of them holds that had already resumed.
    if (holdAutoReleases(job.payload, reason)) {
      logger.info({ jobId: heldJobId, reason }, 'hold: self-clearing, no wedge emitted');
      return;
    }
    const content = HOLD_WEDGE_CONTENT[reason];
    // cm:guard the wedge is the ONLY escalation a hold gets (RFC 0002 INV-7) — it must never grow into a status change or a dispatch block, which is what made the mechanical park cost an intervention per occurrence
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

  // cm:why reached only when nothing waits for this issue any more (a cancel, or a reason with no successor); `syncAgentSessionLifecycle` will not close an issue-kind run — `closeRunIfOneShot` covers pm/interactive only — so without this call the run stays `running` and wedges the project's serial slot
  // cm:guard NEVER close the run when a job was held (RFC 0002 INV-4) — the cascade would cancel the held successor on the way out and the hold would silently become a dead end, which is strictly worse than the park it replaced
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

  // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
  // clears, queued siblings may now classify differently).
  if (updated.issueId) {
    await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  }

  return retry;
}
