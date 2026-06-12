/**
 * Per-class round-robin auto-retry engine (ISS-450, ISS-442 C4).
 *
 * The classifier verdict (Decision C: `code | infra | transient-cc | timeout`)
 * now DRIVES the retry decision — reversing the prior deliberately-uniform
 * design (ISS-407). The branch lives at the call site below; the round-robin
 * machinery is shared:
 *
 *   - **`code`** — a defect the agent cannot retry past. NO retry row is
 *     inserted; we return `{ scheduled: false, reason: 'non_retryable_code' }`
 *     so `finalizeFailedJob` parks the issue at `waiting` for a human.
 *   - **`transient-cc`** — a Claude-CLI startup death (ISS-402). IMMEDIATE
 *     different-device failover: pick an online device ≠ the one that just ran,
 *     skip the `RETRY_COOLDOWN_MS` cooldown, and do NOT burn a same-device
 *     `tries` slot. If no other device is online, fall back to the standard
 *     round-robin (so it still retries, just same-device after cooldown).
 *   - **`infra` / `timeout`** — the existing uniform policy: round-robin across
 *     devices (`RETRY_TRIES_PER_DEVICE` attempts each), `RETRY_COOLDOWN_MS`
 *     (60s) between attempts, bounded by `RETRY_MAX_ROUNDS` (10) full sweeps.
 *
 * The rotation state lives in `payload._autoRetry` and the dispatcher honours
 * it (`target` → pin, `done` → exclude). When the round budget is exhausted
 * (or the kind is `code`) the caller parks the issue at `waiting`.
 *
 * The NON-error structural guards still short-circuit ahead of the kind branch:
 * a job whose cancellation was requested, and the verify-first check (the issue
 * already advanced past / reverted away from this step, so retrying is wasted
 * spend).
 */

import { eq } from 'drizzle-orm';
import { publishSessionRecoveryChanged } from '../agent-sessions/recovery-publish.js';
import {
  incrementAutoRetryCount,
  incrementRecoveryStats,
  markSessionTerminal,
} from '../agent-sessions/recovery-stats.js';
import { db } from '../db/client.js';
import { agentSessionTurns, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { type CcStartupSignals, classifyFailure } from '../pipeline/failure-classifier.js';
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
 * Compute an IMMEDIATE different-device failover for a `transient-cc` (Claude-
 * CLI startup death). Returns a rotation pinning an online device ≠ the one
 * that just ran, WITHOUT consuming a same-device `tries` slot. Returns `null`
 * when no other online device exists (caller falls back to `nextRotation`) or
 * when the round budget is exhausted.
 */
async function differentDeviceFailover(
  job: JobRow,
  state: AutoRetryPayload,
): Promise<AutoRetryPayload | null> {
  if (state.round > RETRY_MAX_ROUNDS) return null;
  const ranOn = job.deviceId ?? null;
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  const online = await onlineCapableDeviceIds(job.projectId, required);
  const other = online.find((d) => d !== ranOn);
  if (!other) return null;
  const done = Array.from(new Set([...state.done, ranOn].filter((x): x is string => Boolean(x))));
  return { round: state.round, target: other, tries: 1, done };
}

/**
 * Derive the structured cc-startup-death signal from the linked agent_session's
 * per-turn rows: a tiny session (≤ a few messages) that never reached its first
 * tool_use is a Claude-CLI startup death (ISS-402). Best-effort — any failure
 * to read returns `undefined` so the classifier falls back to the error-text
 * pattern. The classifier still enforces the ≤3-message threshold.
 */
async function deriveCcStartupSignals(sessionId: string): Promise<CcStartupSignals | undefined> {
  try {
    const rows = await db
      .select({ role: agentSessionTurns.role })
      .from(agentSessionTurns)
      .where(eq(agentSessionTurns.agentSessionId, sessionId));
    return {
      sessionMessageCount: rows.length,
      diedBeforeFirstToolUse: !rows.some((r) => r.role === 'tool'),
    };
  } catch (err) {
    logger.warn({ err, sessionId }, 'retry: cc-startup signal derivation failed, continuing');
    return undefined;
  }
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

  // Classify the failure. The verdict DRIVES the retry decision (the kind
  // branch lives after the verify-first guard below) AND labels the job for the
  // operator UI / recovery stats. When a direct writer (dispatcher / sweeper /
  // stale-detector) already stamped `failureKind`, that wins and we skip the
  // re-classify+persist — but we still derive the cc-startup signal only when
  // we are about to classify (no stamped kind), to avoid an extra query.
  const inputError = typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const needsClassify = job.failureKind === null || job.failureKind === undefined;
  const signals =
    needsClassify && job.agentSessionId
      ? await deriveCcStartupSignals(job.agentSessionId)
      : undefined;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
    signals,
  });
  if (needsClassify) {
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
  // The kind the policy acts on: a direct writer's stamp wins over the
  // (display) classifier verdict so stats + decision stay consistent.
  const effectiveKind = job.failureKind ?? classified.kind;
  if (job.agentSessionId) {
    try {
      await incrementRecoveryStats(job.agentSessionId, effectiveKind);
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

  // Per-class policy (ISS-450 Decision C). `code` is non-retryable — finalize
  // parks the issue at `waiting`. `transient-cc` fails over to a different
  // device immediately. `infra`/`timeout` keep the uniform round-robin.
  if (effectiveKind === 'code') {
    logger.info(
      { jobId: job.id, attempts: job.attempts, reason, failureKind: effectiveKind },
      'retry: non-retryable code failure, parking',
    );
    return { scheduled: false, reason: 'non_retryable_code' };
  }

  const state = readAutoRetryPayload(job.payload);
  // transient-cc → immediate different-device failover (no cooldown, no
  // same-device tries slot). Falls back to the standard rotation when no other
  // device is online so it still retries.
  let next: AutoRetryPayload | null = null;
  let skipCooldown = false;
  if (effectiveKind === 'transient-cc') {
    const failover = await differentDeviceFailover(job, state);
    if (failover) {
      next = failover;
      skipCooldown = true;
    }
  }
  if (next === null && !skipCooldown) {
    next = await nextRotation(job, state);
  }
  // `null` → 10-round budget exhausted → park.
  if (next === null) {
    logger.info(
      { jobId: job.id, attempts: job.attempts, rounds: RETRY_MAX_ROUNDS, reason },
      'retry: round budget exhausted',
    );
    return { scheduled: false, reason: 'retry_rounds_exhausted' };
  }

  const retryAfterAt = skipCooldown
    ? new Date(Date.now())
    : new Date(Date.now() + RETRY_COOLDOWN_MS);
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
