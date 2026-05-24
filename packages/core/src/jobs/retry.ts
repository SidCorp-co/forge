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
 *   3. Skip retry if the classifier says permanent / permission / unknown.
 *   4. Skip retry if the auto-retry budget (3) is exhausted.
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

/** Cap for `unknown` failures. The classifier returns `unknown` when no
 *  pattern matches — usually a transient runner-side death (Tauri's "Agent
 *  completed with errors" fallback) but possibly a genuinely permanent
 *  failure lacking patterns. A single retry is the "give it one more shot"
 *  compromise — recovers genuine transient blips, contains blast radius if
 *  the failure is actually permanent. */
export const MAX_AUTO_RETRIES_UNKNOWN = 1;

/** Budget per classified failure kind.
 *
 * `transient` and `timeout` return `null` = unbounded retries. The classifier
 * already gave evidence the failure is recoverable (network blip, 5xx, 429,
 * runner offline, ETIMEDOUT, heartbeat stale, etc.); a count-based cap would
 * force manualHold the operator must clear, which adds latency without
 * removing the underlying flake. Token spend is bounded by the per-retry
 * cooldown (60s minimum, capped at 24h per provider Retry-After) and by the
 * verify-first gate that aborts retry if the issue advanced. Operator can
 * still cancel by setting `cancellationRequested` on the job.
 *
 * `unknown` keeps the 1-retry cap so a permanent failure masquerading as
 * unknown can't burn unbounded tokens.
 *
 * `permission` / `permanent` are hard-stops upstream and never reach this
 * helper.
 */
function retryBudgetFor(kind: FailureKind): number | null {
  if (kind === 'unknown') return MAX_AUTO_RETRIES_UNKNOWN;
  return null;
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
  // `unknown` is retryable with a tighter budget (see MAX_AUTO_RETRIES_UNKNOWN)
  // — silent runner deaths are usually transient even when the error string
  // matches no pattern. `transient` and `timeout` keep the full budget.
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

  // Step 4 — budget. `null` budget = unbounded (transient + timeout); the
  // per-retry cooldown + verify-first gate are the real safety. attempts
  // starts at 1 for the original; capped kinds burn at most `budget` retries.
  const budget = retryBudgetFor(classified.kind);
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

  // Step 6 — schedule with Retry-After respect. Floor at MIN_RETRY_COOLDOWN_MS
  // so a runaway provider responding `Retry-After: 0` still gets a small
  // breathing room before re-dispatch.
  const minCooldown = new Date(Date.now() + MIN_RETRY_COOLDOWN_MS);
  const retryAfterHint = classified.retryAfter;
  const retryAfterAt =
    retryAfterHint && retryAfterHint > minCooldown ? retryAfterHint : minCooldown;

  const [created] = await db
    .insert(jobs)
    .values({
      projectId: job.projectId,
      issueId: job.issueId,
      pipelineRunId: job.pipelineRunId,
      createdBy: job.createdBy,
      type: job.type,
      payload: job.payload,
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
