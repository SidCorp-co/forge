/**
 * Per-class round-robin auto-retry engine.
 *
 * ISS-823 — driven by the classifier's `action` (`jobs.failure_action`;
 * historical NULL rows fall back to `deriveActionFromKind(failureKind)`):
 * `terminal` never retries; `failover`/`quarantine` (CLI startup death,
 * ISS-402; per-account spend/session limit, ISS-823) do an IMMEDIATE
 * different-device failover, parking `all_devices_exhausted` only when every
 * online device is rate-limited (not merely offline); `retry`
 * (`infra`/`timeout`) takes the standard bounded round-robin: uniform
 * `RETRY_COOLDOWN_MS` (60s) between attempts, `RETRY_TRIES_PER_DEVICE` (3)
 * tries per device before rotating (state in `payload._autoRetry`), bounded
 * by `RETRY_MAX_ROUNDS` (10) sweeps — the failover path shares this budget so
 * it cannot ping-pong unbounded. Detail: docs/modules/agents-jobs.
 *
 * Structural guards ahead of any class: cancellation-requested, and the
 * verify-first check (issue already advanced/reverted, so retrying is wasted
 * spend).
 */

import { randomUUID } from 'node:crypto';
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
import { classifyFailure, deriveActionFromKind } from '../pipeline/failure-classifier.js';
import { verifyRecovery } from '../pipeline/recovery-verifier.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { buildVerifierPrompt } from '../skills/reconcile-service.js';
import { enqueueJob, enqueueReconcileJob } from './enqueue.js';

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
          failureAction: classified.action,
          failureReason: classified.reason,
          failureMeta: classified.meta as never,
          classifierVersion: classified.version,
        })
        .where(eq(jobs.id, job.id));
      job.failureKind = classified.kind;
      job.failureAction = classified.action;
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
      // ISS-702 — this reverses the ISS-197 fail-open-to-pending default for
      // the throw case only. `verifyRecovery` throws solely when its single
      // PK SELECT throws (a DB outage), during which we cannot confirm the
      // issue is still eligible for a retry. Failing open let a stale zombie
      // job's finalize-failure clobber a deliberately-parked `waiting`/
      // `on_hold` status back to this job's entry-status (the ISS-701
      // incident). Fail SAFE instead: no retry, caller parks at `waiting`.
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId },
        'retry: verifyRecovery failed, failing safe — no retry scheduled',
      );
      return { scheduled: false, reason: 'verify_unavailable' };
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

  // cm:why checked AFTER verify-first so an already-advanced issue still resolves completed_via_recovery instead of being parked terminal
  const effectiveAction =
    job.failureAction ?? deriveActionFromKind(job.failureKind ?? classified.kind);
  if (effectiveAction === 'terminal') {
    logger.info(
      { jobId: job.id, failureAction: effectiveAction, reason },
      'retry: non-retryable terminal failure, no retry scheduled',
    );
    return { scheduled: false, reason: 'non_retryable_terminal' };
  }

  // cm:why an empty health-gated set alongside a non-empty unfiltered set means the fleet is up but every box is rate-limited — park instead of blindly rotating
  const isFailoverAction = effectiveAction === 'failover' || effectiveAction === 'quarantine';
  if (isFailoverAction) {
    const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
      ?.requiredCapabilities;
    const [healthyDevices, allDevices] = await Promise.all([
      onlineCapableDeviceIds(job.projectId, required),
      onlineCapableDeviceIds(job.projectId, required, { includeLimited: true }),
    ]);
    if (healthyDevices.length === 0 && allDevices.length > 0) {
      logger.info(
        { jobId: job.id, failureAction: effectiveAction, reason },
        'retry: every online device is rate-limited, parking',
      );
      return { scheduled: false, reason: 'all_devices_exhausted' };
    }
  }

  // cm:why forcing tries to the per-device cap makes nextRotation treat the device that just ran as exhausted, so it rotates immediately instead of spending same-device tries
  const state = readAutoRetryPayload(job.payload);
  let next: AutoRetryPayload | null;
  if (isFailoverAction) {
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
    isFailoverAction && next.target !== null && next.target !== job.deviceId;
  const cooldownMs = immediateFailover ? 0 : RETRY_COOLDOWN_MS;
  const retryAfterAt = new Date(Date.now() + cooldownMs);
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const nextPayload: Record<string, unknown> = {
    ...basePayload,
    [AUTO_RETRY_PAYLOAD_KEY]: next,
  };

  // cm:why the original promptString embeds the DEAD parent job's id as the vote key — reusing it verbatim means the clone's own vote never matches jobs.id and failReconcileRunIfNoVerdictRecorded fails the run despite a successful vote (MINOR V, ISS-801 review round 4).
  let newJobId: string | undefined;
  if (job.type === 'verify_skill' && typeof basePayload.reconcileRunId === 'string') {
    newJobId = randomUUID();
    nextPayload.promptString = await buildVerifierPrompt(basePayload.reconcileRunId, newJobId);
  }

  const [created] = await db
    .insert(jobs)
    .values({
      ...(newJobId ? { id: newJobId } : {}),
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
    // cm:why reconcile/verify_skill retries must stay on RECONCILE_QUEUE_NAME — enqueueJob would land the clone on the coder queue, defeating the lane isolation it exists for (MINOR T, ISS-801 review).
    if (job.type === 'reconcile' || job.type === 'verify_skill') {
      await enqueueReconcileJob(created.id, { startAfterSeconds });
    } else {
      await enqueueJob(
        { jobId: created.id, issueId: job.issueId, type: job.type },
        { startAfterSeconds },
      );
    }
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
