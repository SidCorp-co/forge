/**
 * Verify-first auto-retry engine (ISS-197).
 *
 * Old model (pre-ISS-197): one flat 60s cooldown, regardless of provider
 * Retry-After hint or issue progress. Blind retries burned tokens when the
 * issue had already moved on, and rate-limit responses with
 * `Retry-After: 600` got pinged again after 60s.
 *
 * New model:
 *   1. Classify the failure (classifier v2 — transient | permission |
 *      permanent | timeout | unknown — and an optional Retry-After hint).
 *   2. ALWAYS increment recoveryStats on the linked agent_session, even
 *      for non-retryable kinds; broadcast `session.recoveryChanged`.
 *   3. Skip retry if the classifier says permanent / permission.
 *   4. Skip retry if the phased auto-retry budget (30×1m + 10×5m = 40)
 *      is exhausted; the caller then routes to setManualHoldBlock.
 *   5. Verify-first: if `verifyRecovery` says the issue already advanced
 *      past the failed job's expected exit → mark agent_session as
 *      `completed_via_recovery` and stop. If the issue moved to a
 *      different jobType's territory → mark `cancelled_stale` and stop.
 *   6. Otherwise schedule the retry with `retry_after_at` set to
 *      `max(now + MIN_RETRY_COOLDOWN_MS, classifier.retryAfter)`; the L1
 *      dispatch gate enforces the timestamp.
 *
 * Clean-break: the legacy flat-cooldown constant and the blind-retry path
 * are deleted outright. The floor lives in `pipeline/retry-after-parser.ts`
 * so a grep for the cooldown literal inside `jobs/` stays empty.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { CLASSIFIER_VERSION, classifyFailure, type FailureKind } from '../pipeline/failure-classifier.js';
import { verifyRecovery } from '../pipeline/recovery-verifier.js';
import { MIN_RETRY_COOLDOWN_MS } from '../pipeline/retry-after-parser.js';
import { publishSessionRecoveryChanged } from '../agent-sessions/recovery-publish.js';
import {
  incrementAutoRetryCount,
  incrementRecoveryStats,
  markSessionTerminal,
} from '../agent-sessions/recovery-stats.js';
import { enqueueJob } from './enqueue.js';

type JobRow = typeof jobs.$inferSelect;

export interface RetryOutcome {
  scheduled: boolean;
  newJobId?: string;
  reason?: string;
}

/** Phased retry schedule shared by all retryable kinds (transient / timeout /
 *  unknown):
 *
 *    Phase 1 — 30 retries with a 1-minute cooldown (covers ~30 min of
 *              transient blips and short rate-limit windows).
 *    Phase 2 — 10 retries with a 5-minute cooldown (additional ~50 min for
 *              slower recovery, e.g. extended outages or quota resets).
 *
 *  After 40 total retries (job.attempts ≥ 41) the budget is exhausted; the
 *  caller routes the job through `setManualHoldBlock` for operator review.
 *
 *  Provider `Retry-After` hints still win when they exceed the phase
 *  cooldown — the schedule is a floor, not a ceiling.
 *
 *  `permission` / `permanent` are hard-stops upstream and never reach this
 *  helper. */
export const AUTO_RETRY_PHASE_1_COUNT = 30;
export const AUTO_RETRY_PHASE_2_COUNT = 10;
export const AUTO_RETRY_PHASE_2_COOLDOWN_MS = 5 * 60_000;
export const AUTO_RETRY_MAX_TOTAL = AUTO_RETRY_PHASE_1_COUNT + AUTO_RETRY_PHASE_2_COUNT;

function autoRetryBudgetFor(kind: FailureKind): number | null {
  if (kind === 'permission' || kind === 'permanent') return 0;
  return AUTO_RETRY_MAX_TOTAL;
}

/** Phase-aware cooldown for the upcoming retry. `nextAttempt` is the
 *  attempt# of the retry being scheduled (2 = first retry, 3 = second, ...).
 */
function autoRetryPhasedCooldownMs(nextAttempt: number): number {
  const retryNum = nextAttempt - 1;
  if (retryNum <= AUTO_RETRY_PHASE_1_COUNT) return MIN_RETRY_COOLDOWN_MS;
  return AUTO_RETRY_PHASE_2_COOLDOWN_MS;
}

/** Payload key the dispatcher reads to skip the just-failed device on the
 *  next attempt. See `dispatcher.ts` — when the value matches the project's
 *  primary device, primary selection is skipped so the runner pool rotates
 *  to a standby; single-device projects fall through to the failed device
 *  again (selector retries without exclusion when no alternative exists). */
export const AUTO_RETRY_PAYLOAD_KEY = '_autoRetry';

export interface AutoRetryPayload {
  excludeDeviceId?: string;
}

export function readAutoRetryPayload(payload: unknown): AutoRetryPayload {
  if (!payload || typeof payload !== 'object') return {};
  const raw = (payload as Record<string, unknown>)[AUTO_RETRY_PAYLOAD_KEY];
  return raw && typeof raw === 'object' ? (raw as AutoRetryPayload) : {};
}

/**
 * Verify-first auto-retry. See file header for the full state diagram.
 * Returns `{ scheduled: false, reason }` for every non-retry outcome so the
 * caller (lifecycle / watchdog) can hand off to `setManualHoldBlock` only
 * when the reason isn't a recovery-via-verification skip.
 *
 * Idempotent: budget exhaustion + verification + classifier all guard the
 * insert path.
 */
export async function scheduleAutoRetryWithVerify(
  job: JobRow,
  reason: string,
): Promise<RetryOutcome> {
  if (job.cancellationRequested) {
    return { scheduled: false, reason: 'cancellation_requested' };
  }

  const inputError =
    typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
  });

  // Persist classification on the failed job for the audit trail / operator
  // UI, even when we decide not to retry. Best-effort: a classifier write
  // failure must not break the recovery path.
  if (job.failureKind === null || job.failureKind === undefined) {
    try {
      await db
        .update(jobs)
        .set({
          failureKind: classified.kind,
          failureReason: classified.reason,
          failureMeta: classified.meta as never,
          classifierVersion: classified.version,
        })
        .where(eq(jobs.id, job.id));
      job.failureKind = classified.kind;
      job.failureReason = classified.reason;
      job.classifierVersion = classified.version;
    } catch (err) {
      logger.warn(
        { err, jobId: job.id },
        'retry: failed to persist classification, continuing',
      );
    }
  }

  // ALWAYS increment recoveryStats — even on non-retryable kinds — so the
  // operator UI shows the full failure history. Broadcasts only fire when
  // the increment succeeds.
  if (job.agentSessionId) {
    try {
      await incrementRecoveryStats(job.agentSessionId, classified.kind);
      await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, sessionId: job.agentSessionId },
        'retry: failed to increment recoveryStats, continuing',
      );
    }
  }

  // Step 3 — non-retryable kinds. Only `permission` and `permanent` are
  // hard-stops; classification gave us evidence the failure won't recover.
  // `transient`, `timeout`, and `unknown` share the phased budget — silent
  // runner deaths classified as `unknown` (e.g. Tauri's "Agent completed
  // with errors" fallback) are usually transient and deserve the same
  // recovery window as classified blips.
  if (classified.kind === 'permission' || classified.kind === 'permanent') {
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'session.recovery_skipped',
        data: { sessionId: job.agentSessionId, reason: `kind:${classified.kind}` },
      });
    }
    logger.info(
      {
        jobId: job.id,
        kind: classified.kind,
        classifierVersion: CLASSIFIER_VERSION,
      },
      'retry: kind not retryable, no auto-retry',
    );
    return { scheduled: false, reason: `classifier:${classified.kind}` };
  }

  // Step 4 — budget. attempts starts at 1 for the original job; with the
  // phased budget the cap kicks in at attempts >= AUTO_RETRY_MAX_TOTAL + 1.
  const budget = autoRetryBudgetFor(classified.kind);
  if (budget !== null && job.attempts >= budget + 1) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, reason },
      'retry: auto-retry budget exhausted',
    );
    return { scheduled: false, reason: 'retry_budget_exhausted' };
  }

  // Step 5 — verify-first. If the issue has already moved past the failed
  // step, retrying is wasted token spend.
  if (job.issueId) {
    let verdict;
    try {
      verdict = await verifyRecovery(job);
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId },
        'retry: verifyRecovery failed, defaulting to pending',
      );
      verdict = 'pending' as const;
    }
    if (verdict === 'advanced') {
      if (job.agentSessionId) {
        await markSessionTerminal(job.agentSessionId, 'completed_via_recovery');
        await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
      }
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'session.recovery_skipped',
          data: { sessionId: job.agentSessionId, currentStatus: 'advanced' },
        });
      }
      return { scheduled: false, reason: 'completed_via_recovery' };
    }
    if (verdict === 'reverted') {
      if (job.agentSessionId) {
        await markSessionTerminal(job.agentSessionId, 'cancelled_stale');
        await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
      }
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'session.recovery_skipped',
          data: { sessionId: job.agentSessionId, currentStatus: 'reverted' },
        });
      }
      return { scheduled: false, reason: 'cancelled_stale' };
    }
  }

  // Step 6 — schedule with phase-aware cooldown + Retry-After respect.
  // The phase cooldown grows from 60s (retries 1..30) to 300s (retries 31..40)
  // so we don't burn provider quota with tight retries on slower recoveries.
  // Provider Retry-After still wins when larger than the phase floor.
  const phaseCooldownMs = autoRetryPhasedCooldownMs(job.attempts + 1);
  const phaseFloor = new Date(Date.now() + phaseCooldownMs);
  const retryAfterHint = classified.retryAfter;
  const retryAfterAt =
    retryAfterHint && retryAfterHint > phaseFloor ? retryAfterHint : phaseFloor;

  // Rotate device on each retry when the project has more than one online
  // runner. The dispatcher reads `payload[AUTO_RETRY_PAYLOAD_KEY]` and skips
  // primary selection if the failed device matches; single-device projects
  // still retry on the same device because the selector falls back without
  // the exclusion when no alternative is online.
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const nextPayload: Record<string, unknown> = { ...basePayload };
  if (job.deviceId) {
    const prior = readAutoRetryPayload(basePayload);
    nextPayload[AUTO_RETRY_PAYLOAD_KEY] = {
      ...prior,
      excludeDeviceId: job.deviceId,
    } satisfies AutoRetryPayload;
  }

  const [created] = await db
    .insert(jobs)
    .values({
      projectId: job.projectId,
      issueId: job.issueId,
      pipelineRunId: job.pipelineRunId,
      createdBy: job.createdBy,
      type: job.type,
      payload: nextPayload,
      modelTier: job.modelTier,
      status: 'queued',
      attempts: job.attempts + 1,
      retryOf: job.id,
      retryAfterAt,
      // Carry the agent_session forward so the retry's own future failure
      // increments stats on the same session row.
      agentSessionId: job.agentSessionId,
    })
    .returning({ id: jobs.id });

  if (!created) throw new Error('retry: insert returned no row');

  const startAfterSeconds = Math.max(
    0,
    Math.ceil((retryAfterAt.getTime() - Date.now()) / 1000),
  );
  try {
    await enqueueJob(
      { jobId: created.id, issueId: job.issueId, type: job.type },
      { startAfterSeconds },
    );
  } catch (err) {
    logger.error({ err, jobId: created.id }, 'retry: enqueue failed; row persisted');
  }

  if (job.agentSessionId) {
    try {
      await incrementAutoRetryCount(job.agentSessionId);
      await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, sessionId: job.agentSessionId },
        'retry: failed to increment autoRetries, continuing',
      );
    }
  }

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'session.recovery_attempted',
      data: {
        sessionId: job.agentSessionId,
        attempt: job.attempts + 1,
        cooldownUsed: startAfterSeconds,
        retryAfter: retryAfterAt.toISOString(),
      },
    });
  }

  logger.info(
    {
      originalJobId: job.id,
      newJobId: created.id,
      cooldownSec: startAfterSeconds,
      retryAfterAt: retryAfterAt.toISOString(),
      reason,
    },
    'retry: auto-retry scheduled',
  );

  return { scheduled: true, newJobId: created.id };
}
