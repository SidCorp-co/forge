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

export function nextRotation(
  job: JobRow,
  state: AutoRetryPayload,
  online: string[],
  now: Date,
): RotationOutcome {
  const ranOn = job.deviceId ?? null;
  const target = state.target ?? ranOn;
  const tries = state.target ? state.tries : 1;

  if (online.length === 0) {
    const deferredSince = state.deferredSince ?? now.toISOString();
    const waited = now.getTime() - new Date(deferredSince).getTime();
    if (waited > CAPACITY_DEFER_CEILING_MS) {
      return { kind: 'give_up', reason: 'all_devices_exhausted' };
    }
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
  const tooOld = allLimited
    ? []
    : await onlineCapableDeviceIds(job.projectId, required, {
        includeLimited: true,
        includeBelowFloor: true,
        allowDeviceIds: stagePool,
      });
  const copy = wedgeCopy(allLimited, present.length, tooOld.length, {
    scope: stagePool ? `the ${job.type} runner pool` : 'this project',
  });

  await emitPipelineWedge({
    projectId: job.projectId,
    issueId: job.issueId,
    hop: 'dispatch',
    entity: 'capacity',
    entityId,
    ...copy,
  });
}

/**
 * What to tell an operator about an empty pool, given which of the three ways
 * it is empty.
 */
function wedgeCopy(
  allLimited: boolean,
  limitedCount: number,
  tooOldCount: number,
  args: { scope: string },
): { reason: string; action: string; title: string; summary: string; nextStep: string } {
  const { scope } = args;
  if (allLimited) {
    return {
      reason: `all ${limitedCount} capable device(s) are rate-limited or quarantined`,
      action: 'raise the account limit or wait for the provider reset',
      title: `No capacity: every runner for ${scope} is limited`,
      summary: `Work for ${scope} is paused because all ${limitedCount} of its runners have hit an account limit. Steps keep waiting and resume by themselves once one frees up.`,
      nextStep:
        'Raise the account spend/usage limit, or wait for the provider reset — no other action needed.',
    };
  }
  if (tooOldCount > 0) {
    return {
      reason: `all ${tooOldCount} capable device(s) run a build too old to claim work`,
      action: 'update the runner on those hosts',
      title: `No capacity: every runner for ${scope} is out of date`,
      summary: `Work for ${scope} is paused because all ${tooOldCount} of its runners are online but running a build older than this server requires, so every claim is refused. This does NOT clear by itself.`,
      nextStep:
        'Update forge-runner on those hosts; work resumes on the next tick once they report the new version.',
    };
  }
  return {
    reason: 'no capable device is online',
    action: 'bring a runner online for this project',
    title: `No capacity: no runner online for ${scope}`,
    summary: `Work for ${scope} is paused because none of its runners are online. Steps keep waiting and resume by themselves once one connects.`,
    nextStep: 'Start a runner for this project (forge-runner on a paired device).',
  };
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
export async function deriveCcStartupSignals(
  job: JobRow,
): Promise<{ diedBeforeFirstToolUse: boolean; sessionMessageCount: number } | null> {
  try {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        toolCalls: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'tool_call')::int`,
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
 * Backfill `failure_kind` / `failure_action` on a row that reached here without
 * them, and mirror the write onto the in-memory `job` the caller keeps using.
 */
async function persistClassification(
  job: JobRow,
  classified: ReturnType<typeof classifyFailure>,
): Promise<void> {
  const needsKindPersist = job.failureKind === null || job.failureKind === undefined;
  const needsActionPersist = job.failureAction === null || job.failureAction === undefined;
  if (needsKindPersist || needsActionPersist) {
    const actionToPersist = needsKindPersist
      ? classified.action
      : deriveActionFromKind(job.failureKind as NonNullable<typeof job.failureKind>);
    try {
      await db
        .update(jobs)
        .set({
          ...(needsKindPersist
            ? {
                failureKind: classified.kind,
                failureReason: classified.reason,
                failureMeta: classified.meta as never,
                classifierVersion: classified.version,
              }
            : {}),
          ...(needsActionPersist ? { failureAction: actionToPersist } : {}),
        })
        .where(eq(jobs.id, job.id));
      if (needsKindPersist) {
        job.failureKind = classified.kind;
        job.failureReason = classified.reason;
        job.classifierVersion = classified.version;
      }
      if (needsActionPersist) job.failureAction = actionToPersist;
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'retry: failed to persist classification, continuing');
    }
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
  const inputError = typeof job.error === 'string' && job.error.length > 0 ? job.error : reason;
  const classified = classifyFailure({
    error: inputError,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
    signals: await deriveCcStartupSignals(job),
  });
  await persistClassification(job, classified);

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

  if (job.issueId) {
    let verdict: 'advanced' | 'reverted' | 'pending';
    try {
      verdict = await verifyRecovery(job);
    } catch (err) {
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
  const stagePool = (await resolveStageOverrides(job.projectId, job.payload)).deviceIds;
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  const healthyDevices = await onlineCapableDeviceIds(job.projectId, required, {
    allowDeviceIds: stagePool,
  });

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
    return { scheduled: false, reason: outcome.reason };
  }

  if (outcome.kind === 'defer') {
    await notifyCapacityOutage(job, capacityEntityId, required, stagePool);
  } else {
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
    })
    .returning({ id: jobs.id });

  if (!created) throw new Error('retry: insert returned no row');

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
        cooldownUsed: cooldownMs / 1000,
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
      cooldownSec: cooldownMs / 1000,
      reason,
    },
    'retry: auto-retry scheduled',
  );

  return { scheduled: true, newJobId: created.id };
}
