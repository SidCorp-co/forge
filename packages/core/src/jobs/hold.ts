/**
 * RFC 0002 phase 2 — the hold path. A step that cannot run waits HERE, on the
 * job axis, instead of parking its issue at `waiting`.
 *
 * A hold is a successor row at `status='held'`, not a reused one: the failed
 * attempt keeps its error, its session link and its timings, exactly as the
 * retry engine's clone-per-attempt shape already guarantees. `held` is
 * non-terminal and slotless (see `dispatch-gates.ts`), so the row may sit for
 * hours without wedging the project.
 *
 * Auto-release happens at most ONCE per lineage. A capacity outage that clears
 * earns the job a fresh rotation; a second hold is permanent and raises an
 * alert instead. That bound is why a flapping fleet cannot loop here forever,
 * and it invents no ceiling of its own.
 */

import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { checkMonthlyBudget } from './budget-check.js';
import { enqueueJob, enqueueReconcileJob } from './enqueue.js';
import { AUTO_RETRY_PAYLOAD_KEY } from './retry.js';
import { resolveStageOverrides } from './stage-overrides.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * The `RetryOutcome.reason` values that describe a MACHINE refusing to run the
 * step. Every one of them used to park the issue at `waiting`; every one of
 * them now holds the job.
 */
// cm:guard this set is the whole boundary between the two axes — a reason IN it never touches issues.status (RFC 0002 INV-1), a reason OUT of it must be a genuine conclusion (`cancellation_requested`, `completed_via_*`) that needs no successor at all; adding a business outcome here would silently stop asking a human a question that only a human can answer
export const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'verify_unavailable',
]);

/** Payload key carrying the hold bookkeeping on the successor row. */
export const HOLD_PAYLOAD_KEY = '__hold';

export interface HoldState {
  reason: string;
  heldAt: string;
  /** False once this lineage has already spent its single auto-release. */
  autoRelease: boolean;
}

/**
 * Reasons whose clearance this module can VERIFY before re-queueing. A reason
 * absent here holds until a human moves the issue on — that is the honest
 * answer, not a defect.
 */
// cm:why `retry_rounds_exhausted` and `non_retryable_terminal` are deliberately absent: neither names a condition that can be re-checked, so an auto-release would re-dispatch straight back into the same failure and burn a runner slot per pass
const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'monthly_budget_exhausted',
]);

/** How long a `verify_unavailable` hold waits before it simply tries again. */
export const HOLD_RECHECK_MS = 10 * 60_000;

export function readHoldState(payload: unknown): HoldState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>)[HOLD_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { reason, heldAt, autoRelease } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || typeof heldAt !== 'string') return null;
  return { reason, heldAt, autoRelease: autoRelease === true };
}

/**
 * Insert the held successor for a job whose retries are spent.
 *
 * Returns the new row's id, or `null` when the reason is not a hold reason or
 * the insert lost a race with a concurrent active job for the same issue+type
 * (the `jobs_active_unique` partial index is the arbiter).
 */
// cm:edge lockstep -> packages/core/src/db/schema.ts — `jobs_active_unique` covers `held`, which is what makes a duplicate insert here fail loudly instead of enqueuing two successors for one issue
export async function holdJobForReason(job: JobRow, reason: string): Promise<string | null> {
  if (!HOLD_REASONS.has(reason)) return null;

  const prior = readHoldState(job.payload);
  const state: HoldState = {
    reason,
    heldAt: new Date().toISOString(),
    autoRelease: prior === null && CONDITION_CHECKED_REASONS.has(reason),
  };
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const retryAfterAt = state.autoRelease ? null : new Date(Date.now() + HOLD_RECHECK_MS);

  try {
    const [created] = await db
      .insert(jobs)
      .values({
        projectId: job.projectId,
        issueId: job.issueId,
        pipelineRunId: job.pipelineRunId,
        createdBy: job.createdBy,
        type: job.type,
        payload: { ...basePayload, [HOLD_PAYLOAD_KEY]: state },
        modelTier: job.modelTier,
        status: 'held',
        attempts: job.attempts,
        retryOf: job.id,
        failureReason: reason,
        ...(retryAfterAt ? { retryAfterAt } : {}),
      })
      .returning({ id: jobs.id });
    if (!created) return null;
    logger.info(
      { jobId: created.id, heldFrom: job.id, issueId: job.issueId, ...state },
      'hold: job held',
    );
    return created.id;
  } catch (err) {
    logger.warn({ err, jobId: job.id, reason }, 'hold: successor insert failed');
    return null;
  }
}

async function conditionCleared(job: JobRow, reason: string): Promise<boolean> {
  if (reason === 'monthly_budget_exhausted') {
    const check = await checkMonthlyBudget(job);
    return check.action !== 'pause';
  }
  if (reason === 'all_devices_exhausted') {
    const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
      ?.requiredCapabilities;
    // cm:guard scope the read to the stage pool exactly as retry.ts does — an unscoped "healthy" set releases the hold onto boxes dispatch will refuse, and the job holds again one attempt later having spent its only auto-release
    const pool = (await resolveStageOverrides(job.projectId, job.payload)).deviceIds;
    const healthy = await onlineCapableDeviceIds(job.projectId, required, {
      allowDeviceIds: pool,
    });
    return healthy.length > 0;
  }
  return true;
}

/**
 * Re-queue every held job in `projectId` whose condition has cleared.
 *
 * A released job carries a FRESH rotation: the auto-retry payload is dropped so
 * the recovered fleet gets a full round budget rather than one attempt. Its
 * `autoRelease` flag is already spent, so a second hold is permanent.
 */
export async function releaseHeldJobs(projectId: string): Promise<number> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.status, 'held'),
        or(isNull(jobs.retryAfterAt), lte(jobs.retryAfterAt, now)),
      ),
    );

  let released = 0;
  for (const job of candidates) {
    const state = readHoldState(job.payload);
    const reason = state?.reason ?? job.failureReason ?? '';
    if (state && !state.autoRelease) continue;
    let cleared = false;
    try {
      cleared = await conditionCleared(job, reason);
    } catch (err) {
      logger.warn({ err, jobId: job.id, reason }, 'hold: condition check threw, staying held');
      continue;
    }
    if (!cleared) continue;

    // cm:guard drop the rotation, do not carry it — a fleet that recovered must get a full round budget, and a payload still holding `nextRotation === null` state fails once and holds again with its auto-release already spent
    const { [AUTO_RETRY_PAYLOAD_KEY]: _spentRotation, ...freshPayload } = (job.payload ??
      {}) as Record<string, unknown>;
    const [updated] = await db
      .update(jobs)
      .set({
        status: 'queued',
        queuedAt: now,
        retryAfterAt: null,
        failureKind: null,
        failureReason: null,
        payload: {
          ...freshPayload,
          [HOLD_PAYLOAD_KEY]: { ...state, autoRelease: false },
        },
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'held')))
      .returning({ id: jobs.id, type: jobs.type, issueId: jobs.issueId });
    if (!updated) continue;

    released += 1;
    logger.info({ jobId: job.id, issueId: job.issueId, reason }, 'hold: released to queued');
    try {
      if (updated.type === 'reconcile' || updated.type === 'verify_skill') {
        await enqueueReconcileJob(updated.id);
      } else {
        await enqueueJob({ jobId: updated.id, issueId: updated.issueId, type: updated.type });
      }
    } catch (err) {
      logger.error({ err, jobId: updated.id }, 'hold: enqueue after release failed');
    }
  }
  return released;
}

/** Held jobs for `projectId`, newest first — the alert surface for INV-7. */
export async function listHeldJobs(
  projectId: string,
): Promise<
  Array<{ id: string; issueId: string | null; type: string; reason: string | null; heldAt: Date }>
> {
  const rows = await db
    .select({
      id: jobs.id,
      issueId: jobs.issueId,
      type: jobs.type,
      reason: jobs.failureReason,
      heldAt: jobs.queuedAt,
    })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['held'])))
    .orderBy(sql`${jobs.queuedAt} DESC`);
  return rows;
}
