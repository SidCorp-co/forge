/**
 * Per-class round-robin auto-retry engine.
 *
 * ISS-823 — driven by the classifier's `action` (`jobs.failure_action`;
 * historical NULL rows fall back to `deriveActionFromKind(failureKind)`):
 * `terminal` never retries; `failover`/`quarantine` (CLI startup death,
 * ISS-402; per-account spend/session limit, ISS-823) do an IMMEDIATE
 * different-device failover; `retry` (`infra`/`timeout`) takes the standard
 * bounded round-robin: uniform `RETRY_COOLDOWN_MS` (60s) between attempts,
 * `RETRY_TRIES_PER_DEVICE` (3) tries per device before rotating (state in
 * `payload._autoRetry`), bounded by `RETRY_MAX_ROUNDS` (10) sweeps — the
 * failover path shares this budget so it cannot ping-pong unbounded.
 *
 * A round is one sweep over the devices that can take the work, so an empty
 * pool spends none: the chain DEFERS (`CAPACITY_DEFER_CEILING_MS`), notifies
 * once per pool, and only then gives up with `all_devices_exhausted`, which
 * holds and releases itself. Two structural guards run ahead of any class:
 * cancellation-requested, and verify-first (the issue already advanced or
 * reverted, so retrying is wasted spend).
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
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { classifyFailure, deriveActionFromKind } from '../pipeline/failure-classifier.js';
import { verifyRecovery } from '../pipeline/recovery-verifier.js';
import {
  capacityWedgeEntityId,
  emitPipelineWedge,
  resolvePipelineWedge,
} from '../pipeline/wedge.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { buildVerifierPrompt } from '../skills/reconcile-service.js';
import { enqueueJob, enqueueReconcileJob } from './enqueue.js';
import { resolveStageOverrides } from './stage-overrides.js';

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
 * How long a job may sit deferred for want of ANY usable device before it stops
 * retrying and holds instead.
 */
// cm:guard short on purpose, and the reason is which HOLD REASON the job lands on. Deferring rides out a seconds-long provider throttle (owner call 2026-08-12: an all-limited fleet defers rather than parks) without spending the lineage's single auto-release on a blip. Past this ceiling, holding is strictly cheaper than retrying: `all_devices_exhausted` is condition-checked in jobs/hold.ts, so `releaseHeldJobs` re-queues it the moment a device frees up — zero dispatch churn and zero human interventions. A LONG ceiling would just burn retries against a fleet that is already known to be empty.
export const CAPACITY_DEFER_CEILING_MS = 5 * 60_000;

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
  /** When this chain first found NO usable device. Null once one appears. */
  deferredSince?: string | null;
}

/**
 * What {@link nextRotation} decided. Three outcomes, not two: "nowhere to send
 * it" is not the same answer as "budget spent".
 */
// cm:guard keep `defer` distinct from `give_up` — collapsing them is the defect this type exists to prevent. A round means one sweep over the usable devices, so advancing it when there are none charges the budget for a sweep that never happened: sid-desk went round 2 -> 3 in 90 seconds against a fully rate-limited pool (measured 2026-08-14), reached `retry_rounds_exhausted` (the hold reason with NO auto-release) and needed a human, when the honest answer was `all_devices_exhausted`, which clears itself.
export type RotationOutcome =
  | { kind: 'rotate'; state: AutoRetryPayload }
  | { kind: 'defer'; state: AutoRetryPayload }
  | { kind: 'give_up'; reason: 'retry_rounds_exhausted' | 'all_devices_exhausted' };

/** Always returns a normalized state — never undefined — so callers can read
 *  fields without guards. A first dispatch (no prior state) reads as the
 *  round-1 zero state. */
export function readAutoRetryPayload(payload: unknown): AutoRetryPayload {
  const zero: AutoRetryPayload = {
    round: 1,
    target: null,
    tries: 0,
    done: [],
    deferredSince: null,
  };
  if (!payload || typeof payload !== 'object') return zero;
  const raw = (payload as Record<string, unknown>)[AUTO_RETRY_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return zero;
  const r = raw as Partial<AutoRetryPayload>;
  return {
    round: typeof r.round === 'number' && r.round >= 1 ? r.round : 1,
    target: typeof r.target === 'string' ? r.target : null,
    tries: typeof r.tries === 'number' && r.tries >= 0 ? r.tries : 0,
    done: Array.isArray(r.done) ? r.done.filter((x): x is string => typeof x === 'string') : [],
    deferredSince: typeof r.deferredSince === 'string' ? r.deferredSince : null,
  };
}

/**
 * Decide where the NEXT attempt goes, given the devices that can actually take
 * it. Pure — the caller owns the pool read so both halves see one snapshot.
 *
 * Rules:
 *   0. No usable device → DEFER, spending no round, until
 *      [`CAPACITY_DEFER_CEILING_MS`] has passed; then give up with
 *      `all_devices_exhausted`.
 *   1. If the device that just ran is still the round's target and has tries
 *      left → stay on it (tries + 1).
 *   2. Otherwise the device is done for this round → add it (and the intended
 *      target, if selection couldn't honour the pin) to `done`, then pick the
 *      next online device not yet done this round.
 *   3. If every online device is done → the round is complete. Advance to the
 *      next round (reset `done`) unless we've hit RETRY_MAX_ROUNDS.
 */
// cm:guard every `rotate` outcome below is reached with `online` non-empty, which is what makes `target` non-null STRUCTURALLY rather than by a check. It used to be `online[0] ?? null` on an empty pool, and a null target cost the retry both of its aims at once (dispatcher.ts: `pinDeviceId = autoRetry.target`, `excludeDeviceIds = autoRetry.done`, and the round advance had just cleared `done`) — so it re-picked the box that had only just failed. Reintroducing a rotate path that tolerates an empty pool brings that back.
export function nextRotation(
  job: JobRow,
  state: AutoRetryPayload,
  online: string[],
  now: Date,
): RotationOutcome {
  const ranOn = job.deviceId ?? null;
  // First failure has no prior target: the device that just ran IS this
  // round's first target, and the original attempt counts as its first try.
  const target = state.target ?? ranOn;
  const tries = state.target ? state.tries : 1;

  if (online.length === 0) {
    const deferredSince = state.deferredSince ?? now.toISOString();
    const waited = now.getTime() - new Date(deferredSince).getTime();
    if (waited > CAPACITY_DEFER_CEILING_MS) {
      return { kind: 'give_up', reason: 'all_devices_exhausted' };
    }
    // cm:guard carry `target`, `tries`, `done` and `round` through UNCHANGED — a deferral is the absence of an attempt, so the sweep must resume exactly where it stopped. Rebuilding any of them here re-creates the lost-aim bug from the other direction.
    return { kind: 'defer', state: { ...state, target, tries, deferredSince } };
  }

  if (ranOn && target === ranOn && tries < RETRY_TRIES_PER_DEVICE) {
    return {
      kind: 'rotate',
      state: {
        round: state.round,
        target: ranOn,
        tries: tries + 1,
        done: state.done,
        deferredSince: null,
      },
    };
  }

  const done = Array.from(
    new Set([...state.done, target, ranOn].filter((x): x is string => Boolean(x))),
  );
  const remaining = online.filter((d) => !done.includes(d));

  if (remaining.length > 0) {
    return {
      kind: 'rotate',
      state: {
        round: state.round,
        target: remaining[0] ?? null,
        tries: 1,
        done,
        deferredSince: null,
      },
    };
  }

  const nextRound = state.round + 1;
  if (nextRound > RETRY_MAX_ROUNDS) return { kind: 'give_up', reason: 'retry_rounds_exhausted' };
  // New sweep: clear `done`, start again from the first online device.
  return {
    kind: 'rotate',
    state: { round: nextRound, target: online[0] ?? null, tries: 1, done: [], deferredSince: null },
  };
}

/**
 * Tell the operator the pool has nothing to run on — once per pool, not once
 * per job.
 *
 * The second pool read (`includeLimited`) happens ONLY here, on the deferral
 * path, because it buys exactly one thing: which of the two outages this is.
 */
// cm:guard the two cases need DIFFERENT human actions and must not be merged into "no capacity": every box rate-limited means top up quota or wait out the provider's reset, while nothing online means go bring a runner up. A single message would send the operator to the wrong place half the time.
// cm:edge contract -> packages/core/src/pipeline/wedge.ts — the dedup and the resolve BOTH key on `capacityWedgeEntityId`; a caller that builds the id differently on one side emits a notification nothing can ever clear
async function notifyCapacityOutage(
  job: JobRow,
  entityId: string,
  required: RequiredCapabilities | undefined,
  stagePool: string[] | null,
): Promise<void> {
  const present = await onlineCapableDeviceIds(job.projectId, required, {
    includeLimited: true,
    allowDeviceIds: stagePool,
  });
  const allLimited = present.length > 0;
  const scope = stagePool ? `the ${job.type} runner pool` : 'this project';

  await emitPipelineWedge({
    projectId: job.projectId,
    issueId: job.issueId,
    hop: 'dispatch',
    entity: 'capacity',
    entityId,
    reason: allLimited
      ? `all ${present.length} capable device(s) are rate-limited or quarantined`
      : 'no capable device is online',
    action: allLimited
      ? 'raise the account limit or wait for the provider reset'
      : 'bring a runner online for this project',
    title: allLimited
      ? `No capacity: every runner for ${scope} is limited`
      : `No capacity: no runner online for ${scope}`,
    summary: allLimited
      ? `Work for ${scope} is paused because all ${present.length} of its runners have hit an account limit. Steps keep waiting and resume by themselves once one frees up.`
      : `Work for ${scope} is paused because none of its runners are online. Steps keep waiting and resume by themselves once one connects.`,
    nextStep: allLimited
      ? 'Raise the account spend/usage limit, or wait for the provider reset — no other action needed.'
      : 'Start a runner for this project (forge-runner on a paired device).',
  });
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
// cm:guard exported for the integration test that proves this query RENDERS and RUNS — the predicate reaches into jsonb through a drizzle column reference inside a raw `sql` template, and a template that fails to render is swallowed by the catch below, which logs and returns null, disabling the classifier signal in silence
export async function deriveCcStartupSignals(
  job: JobRow,
): Promise<{ diedBeforeFirstToolUse: boolean; sessionMessageCount: number } | null> {
  try {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        toolCalls: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'tool_call')::int`,
        // cm:guard counts ASSISTANT lines, not stdout rows — the threshold that reads this (`<= 3` in pipeline/failure-classifier.ts) is written as "≤3 assistant messages", and a bare stdout count stopped meaning that when `--include-partial-messages` landed (ISS-479): one assistant turn now emits 6-10 stdout rows, so the classifier quietly stopped firing for the class it was built for
        // cm:edge contract -> packages/core/src/jobs/events-routes.ts — `stream_event` rows are no longer persisted at all, so a stdout count would have shifted again here; naming the frame keeps this signal independent of which frames are stored
        messages: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'stdout' AND ${jobEvents.data}->'line'->>'type' = 'assistant')::int`,
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
  // ISS-450 — the classification below DRIVES the per-class retry policy
  // (code → no retry, transient-cc → immediate device failover) as well as
  // labelling the row for the operator UI / recovery stats.
  const inputError = typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
    signals: await deriveCcStartupSignals(job),
  });
  // cm:why ISS-823 review #2 — gated independently so a row whose failureKind was pre-stamped at flip time (dispatcher.ts/lifecycle-routes.ts/loop-monitor.ts/runs-cascade.ts) still gets failure_action written instead of reading null on the forge_jobs projection
  const needsKindPersist = job.failureKind === null || job.failureKind === undefined;
  const needsActionPersist = job.failureAction === null || job.failureAction === undefined;
  if (needsKindPersist || needsActionPersist) {
    // cm:why backfills from the EXISTING failureKind, not from re-classifying the current error text, so the persisted action never disagrees with the effectiveAction fallback below
    const actionToPersist = needsKindPersist
      ? classified.action
      : deriveActionFromKind(job.failureKind as NonNullable<typeof job.failureKind>);
    try {
      const patch: Partial<JobRow> = {};
      if (needsKindPersist) {
        patch.failureKind = classified.kind;
        patch.failureReason = classified.reason;
        patch.failureMeta = classified.meta as never;
        patch.classifierVersion = classified.version;
      }
      if (needsActionPersist) {
        patch.failureAction = actionToPersist;
      }
      await db.update(jobs).set(patch).where(eq(jobs.id, job.id));
      if (needsKindPersist) {
        job.failureKind = classified.kind;
        job.failureReason = classified.reason;
        job.classifierVersion = classified.version;
      }
      if (needsActionPersist) {
        job.failureAction = actionToPersist;
      }
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'retry: failed to persist classification, continuing');
    }
  }

  // cm:guard ISS-812 AC2 — this guard must stay BELOW the persist block above: a cancelled job still failed, and returning before classification is what left 4 rows on forge-beta (measured 2026-08-26, 60d window) at status='failed' carrying real error text ([NO_RESULT_EXIT], [RESULT_ERROR]) with failure_kind, failure_reason and classifier_version all NULL. Every other no-retry path pre-stamps the row at flip time; this was the only one that recorded nothing, and silence is the defect the epic exists to remove.
  if (job.cancellationRequested) {
    return { scheduled: false, reason: 'cancellation_requested' };
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

  const isFailoverAction = effectiveAction === 'failover' || effectiveAction === 'quarantine';
  // cm:why resolved once and threaded into BOTH the capacity notification and the rotation: reading the pool twice could straddle a config edit and let the two disagree about which boxes exist
  const stagePool = (await resolveStageOverrides(job.projectId, job.payload)).deviceIds;
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  // cm:guard scope the read to the pool and read it for EVERY action, not just failover — an unscoped set makes a fully-limited pool look survivable, and skipping the read on the `retry` action is how an infra retry used to burn its whole budget against boxes dispatch would refuse
  const healthyDevices = await onlineCapableDeviceIds(job.projectId, required, {
    allowDeviceIds: stagePool,
  });

  // cm:why forcing tries to the per-device cap makes nextRotation treat the device that just ran as exhausted, so it rotates immediately instead of spending same-device tries
  const state = readAutoRetryPayload(job.payload);
  const outcome = nextRotation(
    job,
    isFailoverAction
      ? { ...state, target: state.target ?? job.deviceId ?? null, tries: RETRY_TRIES_PER_DEVICE }
      : state,
    healthyDevices,
    new Date(),
  );

  const stageKey = stagePool ? job.type : 'all';
  const capacityEntityId = capacityWedgeEntityId(job.projectId, stageKey);

  if (outcome.kind === 'give_up') {
    logger.info(
      { jobId: job.id, attempts: job.attempts, rounds: RETRY_MAX_ROUNDS, reason: outcome.reason },
      'retry: chain stopped',
    );
    // cm:guard the reason now comes from WHAT HAPPENED, not from a reading taken at give-up time. It used to be `allRunnersLimited ? … : …` evaluated on entry, so one device recovering for one instant mid-burn flipped a capacity outage to `retry_rounds_exhausted` — the hold reason that never auto-releases — and the job then needed a human forever.
    return { scheduled: false, reason: outcome.reason };
  }

  if (outcome.kind === 'defer') {
    await notifyCapacityOutage(job, capacityEntityId, required, stagePool);
  } else {
    // cm:guard resolving here is what makes the capacity notification self-clearing — a successful rotation IS the recovery, and nothing else observes it. Without this the bell stays red about a pool that came back.
    await resolvePipelineWedge(capacityEntityId);
  }
  const next = outcome.state;

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
      // cm:guard never carry agentSessionId onto the clone — the parent's session is terminal, and copying it would short-circuit ensureAgentSessionForJob's dispatch-time insert and make the job a false reconcileOrphanedJobs candidate. Leaving it NULL lets ensureAgentSessionForJob mint a fresh row, chained via metadata.attempt/retryOfSessionId/rootSessionId, never overwriting the reaped attempt's transcript (ISS-434/ISS-785).
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
