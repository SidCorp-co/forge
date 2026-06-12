/**
 * Per-class round-robin auto-retry engine.
 *
 * ISS-450 (ISS-442 C4 / I4) — this REVERSES the ISS-407 "uniform, no
 * per-error branching" design. The classifier verdict now DRIVES the retry
 * decision, with one policy per failure class:
 *
 *   - **`code`** — the work itself is wrong (validation, content filter,
 *     unsupported type). Retrying burns spend without changing the outcome →
 *     NO retry; the caller parks the issue at `waiting` immediately.
 *   - **`transient-cc`** — Claude-CLI startup death (ISS-402 class). Burning
 *     the same-device tries against a wedged CLI install wasted 46 retries on
 *     ISS-402 before rotation saved it → IMMEDIATE different-device failover:
 *     no cooldown, no same-device tries, straight to the next online device.
 *     Falls back to the standard rotation when no other device is online.
 *   - **`infra` / `timeout`** — environment failures. Standard bounded
 *     round-robin (below), unchanged from ISS-407.
 *
 * The standard rotation:
 *   - **Uniform cooldown.** `RETRY_COOLDOWN_MS` (60s) between attempts.
 *   - **Round-robin across devices.** Each device gets `RETRY_TRIES_PER_DEVICE`
 *     (3) attempts before the chain rotates to the next online device. The
 *     project's `defaultDeviceId` (primary) only decides the FIRST dispatch;
 *     from the first retry on, every online device is treated equally. The
 *     rotation state lives in `payload._autoRetry` and the dispatcher honours
 *     it (`target` → pin, `done` → exclude).
 *   - **Bounded.** After `RETRY_MAX_ROUNDS` (10) full sweeps the chain stops
 *     and the caller parks the issue at `waiting` for a human. The
 *     `transient-cc` failover path consumes the SAME round budget (it burns a
 *     device's slot per hop), so it cannot ping-pong unbounded.
 *
 * Structural guards that short-circuit any class: a job whose cancellation
 * was requested, and the verify-first check (the issue already advanced past /
 * reverted away from this step, so retrying would be wasted spend).
 */

import { eq, sql } from 'drizzle-orm';
import { publishSessionRecoveryChanged } from '../agent-sessions/recovery-publish.js';
import {
  incrementAutoRetryCount,
  incrementRecoveryStats,
  markSessionTerminal,
} from '../agent-sessions/recovery-stats.js';
import { db } from '../db/client.js';
import { jobEvents, jobs } from '../db/schema.js';
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
 * ISS-450 — derive the structured cc-startup-death signal from the failed
 * job's event stream: the CLI spawned (≥1 event) but died having emitted zero
 * `tool_call` events and ≤3 assistant (`stdout`) messages. A job with ZERO
 * events never spawned at all (dispatch_unclaimed class) — that is an infra
 * failure, not a cc-startup death, so `diedBeforeFirstToolUse` stays false.
 * Best-effort: a query failure returns null (classifier falls through to its
 * text patterns).
 */
async function deriveCcStartupSignals(
  job: JobRow,
): Promise<{ diedBeforeFirstToolUse: boolean; sessionMessageCount: number } | null> {
  try {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        toolCalls: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'tool_call')::int`,
        messages: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'stdout')::int`,
      })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id));
    if (!row) return null;
    return {
      diedBeforeFirstToolUse: row.total > 0 && row.toolCalls === 0,
      sessionMessageCount: row.messages,
    };
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'retry: cc-startup signal derive failed, skipping');
    return null;
  }
}

/**
 * Schedule the next retry under the per-class policy (see module header), or
 * return `{ scheduled: false }` so the caller parks the issue at `waiting`.
 *
 * Idempotent: cancellation + class policy + verify-first + round budget all
 * guard the insert.
 */
export async function scheduleAutoRetryWithVerify(
  job: JobRow,
  reason: string,
): Promise<RetryOutcome> {
  if (job.cancellationRequested) {
    return { scheduled: false, reason: 'cancellation_requested' };
  }

  // ISS-450 — the classification below DRIVES the per-class retry policy
  // (code → no retry, transient-cc → immediate device failover) as well as
  // labelling the row for the operator UI / recovery stats.
  const inputError = typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
    signals: await deriveCcStartupSignals(job),
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

  // ISS-450 — per-class policy. `code` failures never retry: the work itself
  // is wrong, so re-running it burns spend without changing the outcome. The
  // caller (finalizeFailedJob) parks the issue at `waiting` for a human.
  // Checked AFTER verify-first so an already-advanced issue still resolves as
  // completed_via_recovery instead of being parked.
  const effectiveKind = job.failureKind ?? classified.kind;
  if (effectiveKind === 'code') {
    logger.info(
      { jobId: job.id, failureKind: effectiveKind, reason },
      'retry: non-retryable code failure, no retry scheduled',
    );
    return { scheduled: false, reason: 'non_retryable_code' };
  }

  // Round-robin rotation. `null` → 10-round budget exhausted → park.
  //
  // ISS-450 — `transient-cc` (cc-startup death) does an IMMEDIATE
  // different-device failover: same-device retries burn the whole budget
  // against a wedged CLI install (ISS-402: 46 wasted retries). Forcing
  // `tries` to the per-device cap makes `nextRotation` treat the device that
  // just ran as exhausted, so it picks the next online device (or advances
  // the round — keeping the same RETRY_MAX_ROUNDS bound). Cooldown is skipped
  // only when the failover actually landed on a different device; when no
  // other device is online the standard cooldown applies (same device needs
  // the breather).
  const state = readAutoRetryPayload(job.payload);
  let next: AutoRetryPayload | null;
  if (effectiveKind === 'transient-cc') {
    next = await nextRotation(job, {
      ...state,
      target: state.target ?? job.deviceId ?? null,
      tries: RETRY_TRIES_PER_DEVICE,
    });
  } else {
    next = await nextRotation(job, state);
  }
  if (next === null) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, rounds: RETRY_MAX_ROUNDS, reason },
      'retry: round budget exhausted',
    );
    return { scheduled: false, reason: 'retry_rounds_exhausted' };
  }

  const immediateFailover =
    effectiveKind === 'transient-cc' && next.target !== null && next.target !== job.deviceId;
  const cooldownMs = immediateFailover ? 0 : RETRY_COOLDOWN_MS;
  const retryAfterAt = new Date(Date.now() + cooldownMs);
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
