/**
 * Uniform round-robin auto-retry engine.
 *
 * Design (deliberately simple + transparent — one policy for EVERY failure):
 *
 *   - **No per-error branching.** A failure is a failure. We do NOT inspect the
 *     failure kind to decide whether/how to retry — `transient`, `permanent`,
 *     a weekly-usage-limit, an "Unknown command" skill glitch, a silent runner
 *     death: all retry the same way. (The classifier still runs, but ONLY to
 *     persist a human-readable label on the job + recovery stats for the
 *     operator UI; it never gates the retry decision. See the loud comment at
 *     the call site.)
 *   - **Uniform cooldown.** Every retry waits exactly `RETRY_COOLDOWN_MS`
 *     (60s). No phases, no provider Retry-After parsing.
 *   - **Round-robin across devices.** Each device gets `RETRY_TRIES_PER_DEVICE`
 *     (3) attempts before the chain rotates to the next online device. The
 *     project's `defaultDeviceId` (primary) only decides the FIRST dispatch;
 *     from the first retry on, every online device is treated equally. The
 *     rotation state lives in `payload._autoRetry` and the dispatcher honours
 *     it (`target` → pin, `done` → exclude).
 *   - **Bounded.** After `RETRY_MAX_ROUNDS` (10) full sweeps the chain stops
 *     and the caller parks the issue at `waiting` for a human.
 *
 * The only NON-error guards that can still short-circuit a retry are
 * structural, not error-type: a job whose cancellation was requested, and the
 * verify-first check (the issue already advanced past / reverted away from
 * this step, so retrying would be wasted spend).
 */

import { eq } from 'drizzle-orm';
import { publishSessionRecoveryChanged } from '../agent-sessions/recovery-publish.js';
import {
  incrementAutoRetryCount,
  incrementRecoveryStats,
  markSessionTerminal,
} from '../agent-sessions/recovery-stats.js';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { classifyFailure } from '../pipeline/failure-classifier.js';
import { verifyRecovery } from '../pipeline/recovery-verifier.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { enqueueJob } from './enqueue.js';

type JobRow = typeof jobs.$inferSelect;

export interface RetryOutcome {
  scheduled: boolean;
  newJobId?: string;
  reason?: string;
}

/** Uniform cooldown between every retry. No phases, no Retry-After. */
export const RETRY_COOLDOWN_MS = 60_000;

/** Attempts a single device gets before the chain rotates to the next one. */
export const RETRY_TRIES_PER_DEVICE = 3;

/** Full device sweeps before the chain gives up and the caller parks the
 *  issue at `waiting`. */
export const RETRY_MAX_ROUNDS = 10;

/**
 * Round-robin rotation state carried on `payload[AUTO_RETRY_PAYLOAD_KEY]`.
 *
 *   - `round`  — 1-based sweep counter (1..RETRY_MAX_ROUNDS).
 *   - `target` — device the NEXT attempt should land on (dispatcher pins it).
 *   - `tries`  — attempts already spent on `target` this round (1..TRIES).
 *   - `done`   — devices that finished their tries this round (dispatcher
 *                excludes them so the sweep doesn't repeat a device).
 */
export const AUTO_RETRY_PAYLOAD_KEY = '_autoRetry';

export interface AutoRetryPayload {
  round: number;
  target: string | null;
  tries: number;
  done: string[];
}

/** Always returns a normalized state — never undefined — so callers can read
 *  fields without guards. A first dispatch (no prior state) reads as the
 *  round-1 zero state. */
export function readAutoRetryPayload(payload: unknown): AutoRetryPayload {
  const zero: AutoRetryPayload = { round: 1, target: null, tries: 0, done: [] };
  if (!payload || typeof payload !== 'object') return zero;
  const raw = (payload as Record<string, unknown>)[AUTO_RETRY_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return zero;
  const r = raw as Partial<AutoRetryPayload>;
  return {
    round: typeof r.round === 'number' && r.round >= 1 ? r.round : 1,
    target: typeof r.target === 'string' ? r.target : null,
    tries: typeof r.tries === 'number' && r.tries >= 0 ? r.tries : 0,
    done: Array.isArray(r.done) ? r.done.filter((x): x is string => typeof x === 'string') : [],
  };
}

/**
 * Compute the rotation state for the NEXT attempt, or `null` to stop (the
 * 10-round budget is exhausted). Pure except for the online-device lookup.
 *
 * Rules:
 *   1. If the device that just ran is still the round's target and has tries
 *      left → stay on it (tries + 1).
 *   2. Otherwise the device is done for this round → add it (and the intended
 *      target, if selection couldn't honour the pin) to `done`, then pick the
 *      next online device not yet done this round.
 *   3. If every online device is done → the round is complete. Advance to the
 *      next round (reset `done`) unless we've hit RETRY_MAX_ROUNDS, in which
 *      case return `null` to stop.
 */
async function nextRotation(
  job: JobRow,
  state: AutoRetryPayload,
): Promise<AutoRetryPayload | null> {
  const ranOn = job.deviceId ?? null;
  // First failure has no prior target: the device that just ran IS this
  // round's first target, and the original attempt counts as its first try.
  const target = state.target ?? ranOn;
  const tries = state.target ? state.tries : 1;

  if (ranOn && target === ranOn && tries < RETRY_TRIES_PER_DEVICE) {
    return { round: state.round, target: ranOn, tries: tries + 1, done: state.done };
  }

  const done = Array.from(
    new Set([...state.done, target, ranOn].filter((x): x is string => Boolean(x))),
  );
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  const online = await onlineCapableDeviceIds(job.projectId, required);
  const remaining = online.filter((d) => !done.includes(d));

  if (remaining.length > 0) {
    return { round: state.round, target: remaining[0] ?? null, tries: 1, done };
  }

  const nextRound = state.round + 1;
  if (nextRound > RETRY_MAX_ROUNDS) return null;
  // New sweep: clear `done`, start again from the first online device.
  return { round: nextRound, target: online[0] ?? null, tries: 1, done: [] };
}

/**
 * Schedule the next uniform round-robin retry, or return `{ scheduled: false }`
 * so the caller parks the issue at `waiting`.
 *
 * Idempotent: cancellation + verify-first + round budget all guard the insert.
 */
export async function scheduleAutoRetryWithVerify(
  job: JobRow,
  reason: string,
): Promise<RetryOutcome> {
  if (job.cancellationRequested) {
    return { scheduled: false, reason: 'cancellation_requested' };
  }

  // --- DISPLAY ONLY ---------------------------------------------------------
  // Classify the failure purely to label it for the operator UI / recovery
  // stats. This NEVER influences whether or how we retry — every failure is
  // retried by the same uniform round-robin policy below. Do not add a
  // `if (classified.kind === …) return` branch here.
  const inputError = typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
  });
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
      logger.warn({ err, jobId: job.id }, 'retry: failed to persist classification, continuing');
    }
  }
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
  // --- END DISPLAY ONLY -----------------------------------------------------

  // Verify-first (structural, NOT error-type): if the issue already moved past
  // this step, retrying is wasted spend.
  if (job.issueId) {
    let verdict: 'advanced' | 'reverted' | 'pending';
    try {
      verdict = await verifyRecovery(job);
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId },
        'retry: verifyRecovery failed, defaulting to pending',
      );
      verdict = 'pending';
    }
    if (verdict === 'advanced') {
      if (job.agentSessionId) {
        await markSessionTerminal(job.agentSessionId, 'completed_via_recovery');
        await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
      }
      return { scheduled: false, reason: 'completed_via_recovery' };
    }
    if (verdict === 'reverted') {
      if (job.agentSessionId) {
        await markSessionTerminal(job.agentSessionId, 'cancelled_stale');
        await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
      }
      return { scheduled: false, reason: 'cancelled_stale' };
    }
  }

  // Uniform round-robin rotation. `null` → 10-round budget exhausted → park.
  const state = readAutoRetryPayload(job.payload);
  const next = await nextRotation(job, state);
  if (next === null) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, rounds: RETRY_MAX_ROUNDS, reason },
      'retry: round budget exhausted',
    );
    return { scheduled: false, reason: 'retry_rounds_exhausted' };
  }

  const retryAfterAt = new Date(Date.now() + RETRY_COOLDOWN_MS);
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const nextPayload: Record<string, unknown> = {
    ...basePayload,
    [AUTO_RETRY_PAYLOAD_KEY]: next,
  };

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
      // Intentionally DO NOT carry agentSessionId onto the clone: it must be
      // born NULL. The parent's linked session is terminal (`failed` after the
      // failure that triggered this retry), and copying it here would (a) let
      // `ensureAgentSessionForJob` early-return at dispatch — short-circuiting
      // its `retryOf` reuse+reset branch that flips the session back to
      // `queued`/startedAt:null/failureReason:null — leaving a terminal session
      // linked to a freshly-dispatched job, and (b) make the job a candidate
      // for `reconcileOrphanedJobs`, which reaps it `session_lost` on the next
      // sweeper tick. Leaving it NULL means the orphan reconciler's
      // JOIN on agent_session_id finds no row, and `ensureAgentSessionForJob`
      // re-links + resets the SAME session row (via the retryOf lookup) at
      // dispatch, preserving the one-session-per-retry-chain invariant. (ISS-434)
    })
    .returning({ id: jobs.id });

  if (!created) throw new Error('retry: insert returned no row');

  const startAfterSeconds = Math.max(0, Math.ceil((retryAfterAt.getTime() - Date.now()) / 1000));
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
        round: next.round,
        target: next.target,
        cooldownUsed: startAfterSeconds,
      },
    });
  }

  logger.info(
    {
      originalJobId: job.id,
      newJobId: created.id,
      round: next.round,
      target: next.target,
      tries: next.tries,
      cooldownSec: startAfterSeconds,
      reason,
    },
    'retry: auto-retry scheduled',
  );

  return { scheduled: true, newJobId: created.id };
}
