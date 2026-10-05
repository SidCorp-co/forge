import {
  AUTO_RETRY_PAYLOAD_KEY,
  type AutoRetryPayload,
  FAILOVER_MAX_ATTEMPTS,
  RETRY_MAX_ATTEMPTS,
  readAutoRetryPayload,
} from '@forge/contracts/jobs';
import { eq, sql } from 'drizzle-orm';
import {
  incrementAutoRetryCount,
  incrementRecoveryStats,
  markSessionTerminal,
  publishSessionRecoveryChanged,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { jobEvents, jobs } from '../db/schema.js';
import { traceStep } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import {
  assertRunAcceptsWork,
  capacityWedgeEntityId,
  classifyFailure,
  deriveActionFromKind,
  emitPipelineWedge,
  resolvePipelineWedge,
  verifyRecovery,
} from '../pipeline/index.js';
import type { RequiredCapabilities } from '../runners/index.js';
import { onlineCapableDeviceIds } from '../runners/index.js';
import { RUN_CLOSED } from './hold.js';

type JobRow = typeof jobs.$inferSelect;

export {
  AUTO_RETRY_PAYLOAD_KEY,
  type AutoRetryPayload,
  readAutoRetryPayload,
} from '@forge/contracts/jobs';

export interface RetryOutcome {
  scheduled: boolean;
  newJobId?: string;
  reason?: string;
}

/** Uniform cooldown between every retry. No phases, no Retry-After. */
const RETRY_COOLDOWN_MS = 60_000;

/**
 * How long a job may sit deferred for want of ANY usable device before it stops
 * retrying and holds instead.
 */
const CAPACITY_DEFER_CEILING_MS = 5 * 60_000;

/**
 * What {@link nextRetry} decided. Three outcomes, not two: "nowhere to send
 * it" is not the same answer as "budget spent".
 */
type RetryDecision =
  | { kind: 'retry'; state: AutoRetryPayload }
  | { kind: 'defer'; state: AutoRetryPayload }
  | { kind: 'give_up'; reason: 'retry_rounds_exhausted' | 'all_devices_exhausted' };

function nextRetry(job: JobRow, maxAttempts: number, online: string[], now: Date): RetryDecision {
  if (job.attempts + 1 > maxAttempts) return { kind: 'give_up', reason: 'retry_rounds_exhausted' };
  if (online.length > 0) return { kind: 'retry', state: { maxAttempts, deferredSince: null } };
  const deferredSince = readAutoRetryPayload(job.payload)?.deferredSince ?? now.toISOString();
  if (now.getTime() - new Date(deferredSince).getTime() > CAPACITY_DEFER_CEILING_MS) {
    return { kind: 'give_up', reason: 'all_devices_exhausted' };
  }
  return { kind: 'defer', state: { maxAttempts, deferredSince } };
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
): Promise<void> {
  const present = await onlineCapableDeviceIds(job.projectId, required, {
    includeLimited: true,
  });
  const allLimited = present.length > 0;
  const tooOld = allLimited
    ? []
    : await onlineCapableDeviceIds(job.projectId, required, {
        includeLimited: true,
        includeBelowFloor: true,
      });
  const copy = wedgeCopy(allLimited, present.length, tooOld.length, {
    scope: 'this project',
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
 * `tool_call` events and ≤3 assistant (`stdout`) messages. Only a job that streamed the CLI's
 * output can say so: a pool job runs in a pane, emits `progress` events alone, and read here
 * without that guard every one of its failures was a death before the first tool, however much
 * the agent had done. A job with ZERO events never spawned at all (dispatch_unclaimed class).
 * Best-effort: a query failure returns null (classifier falls through to its
 * text patterns).
 */
async function deriveCcStartupSignals(
  job: JobRow,
): Promise<{ diedBeforeFirstToolUse: boolean; sessionMessageCount: number } | null> {
  try {
    const [row] = await db
      .select({
        streamed: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'stdout')::int`,
        toolCalls: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'tool_call')::int`,
        messages: sql<number>`count(*) FILTER (WHERE ${jobEvents.kind} = 'stdout' AND ${jobEvents.data}->'line'->>'type' = 'assistant')::int`,
      })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id));
    if (!row) return null;
    return {
      diedBeforeFirstToolUse: row.streamed > 0 && row.toolCalls === 0,
      sessionMessageCount: row.messages,
    };
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'retry: cc-startup signal derive failed, skipping');
    return null;
  }
}

/**
 * Classify the failure, then backfill `failure_kind` / `failure_action` on a row
 * that reached here without them, mirroring the write onto the in-memory `job`.
 */
async function classifyAndPersist(job: JobRow, reason: string) {
  const classified = classifyFailure({
    error: typeof job.error === 'string' && job.error.length > 0 ? job.error : reason,
    meta: (job.failureMeta as Record<string, unknown> | null) ?? null,
    signals: await deriveCcStartupSignals(job),
  });
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
  return classified;
}

/** Best-effort session bookkeeping: a failure to count never stops the chain. */
async function bumpSession(
  job: JobRow,
  what: string,
  bump: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  if (!job.agentSessionId) return;
  try {
    await bump(job.agentSessionId);
    await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, sessionId: job.agentSessionId },
      `retry: failed to increment ${what}, continuing`,
    );
  }
}

/** Verify-first: an issue that already advanced or reverted takes no retry. */
async function settleByVerdict(job: JobRow): Promise<RetryOutcome | null> {
  if (!job.issueId) return null;
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
  if (verdict === 'pending') return null;
  const terminal = verdict === 'advanced' ? 'completed_via_recovery' : 'cancelled_stale';
  if (job.agentSessionId) {
    await markSessionTerminal(job.agentSessionId, terminal);
    await publishSessionRecoveryChanged(job.projectId, job.agentSessionId);
  }
  return { scheduled: false, reason: terminal };
}

async function insertRetryJob(
  job: JobRow,
  next: AutoRetryPayload,
  retryAfterAt: Date,
): Promise<string> {
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const [created] = await db.transaction(async (tx) => {
    await assertRunAcceptsWork(tx, job.pipelineRunId);
    return tx
      .insert(jobs)
      .values({
        projectId: job.projectId,
        issueId: job.issueId,
        pipelineRunId: job.pipelineRunId,
        createdBy: job.createdBy,
        type: job.type,
        payload: { ...basePayload, [AUTO_RETRY_PAYLOAD_KEY]: next },
        modelTier: job.modelTier,
        status: 'queued',
        attempts: job.attempts + 1,
        retryOf: job.id,
        retryAfterAt,
      })
      .returning({ id: jobs.id });
  });
  if (!created) throw new Error('retry: insert returned no row');
  return created.id;
}

/**
 * Schedule the next retry under the per-class policy (see module header), or
 * return `{ scheduled: false }` once the budget is spent.
 *
 * Idempotent: cancellation + class policy + verify-first + attempt budget all
 * guard the insert.
 */
export async function scheduleAutoRetryWithVerify(
  job: JobRow,
  reason: string,
): Promise<RetryOutcome> {
  const classified = await classifyAndPersist(job, reason);
  if (job.cancellationRequested) return { scheduled: false, reason: 'cancellation_requested' };
  await bumpSession(job, 'recoveryStats', (id) => incrementRecoveryStats(id, classified.kind));
  const settled = await settleByVerdict(job);
  if (settled) return settled;

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
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  const healthyDevices = await onlineCapableDeviceIds(job.projectId, required);
  const outcome = nextRetry(
    job,
    isFailoverAction ? FAILOVER_MAX_ATTEMPTS : RETRY_MAX_ATTEMPTS,
    healthyDevices,
    new Date(),
  );
  const capacityEntityId = capacityWedgeEntityId(job.projectId, 'all');
  if (outcome.kind === 'give_up') {
    logger.info(
      { jobId: job.id, attempts: job.attempts, reason: outcome.reason },
      'retry: chain stopped',
    );
    return { scheduled: false, reason: outcome.reason };
  }
  if (outcome.kind === 'defer') await notifyCapacityOutage(job, capacityEntityId, required);
  else await resolvePipelineWedge(capacityEntityId);
  const next = outcome.state;

  // A failover retries at once for whichever box claims it.
  const cooldownMs = isFailoverAction ? 0 : RETRY_COOLDOWN_MS;
  let newJobId: string;
  try {
    newJobId = await insertRetryJob(job, next, new Date(Date.now() + cooldownMs));
  } catch (err) {
    if (!isRefusal(err, 'RUN_NOT_ACCEPTING_WORK')) throw err;
    logger.info({ jobId: job.id, runId: job.pipelineRunId }, 'retry: run closed, no retry');
    return { scheduled: false, reason: RUN_CLOSED };
  }
  await bumpSession(job, 'autoRetries', incrementAutoRetryCount);

  traceStep({
    category: 'session.recovery_attempted',
    data: {
      sessionId: job.agentSessionId,
      attempt: job.attempts + 1,
      maxAttempts: next.maxAttempts,
      cooldownUsed: cooldownMs / 1000,
    },
  });
  logger.info(
    {
      originalJobId: job.id,
      newJobId,
      attempt: job.attempts + 1,
      maxAttempts: next.maxAttempts,
      cooldownSec: cooldownMs / 1000,
      reason,
    },
    'retry: auto-retry scheduled',
  );
  return { scheduled: true, newJobId };
}
