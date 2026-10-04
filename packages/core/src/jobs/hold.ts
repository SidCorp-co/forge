import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobType, jobs } from '../db/schema.js';
import { type KernelActor, type KernelExecutor, transition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { resolvePipelineWedge } from '../pipeline/wedge.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { AUTO_RETRY_PAYLOAD_KEY } from './retry.js';

type JobRow = typeof jobs.$inferSelect;

export const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
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
 * Reasons whose clearance this module can VERIFY before re-queueing, by
 * re-running the check that failed.
 */
const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set(['all_devices_exhausted']);

/**
 * Reasons with nothing to re-check: waiting IS the whole remedy, so the hold
 * simply retries once {@link HOLD_RECHECK_MS} has passed.
 */
const TIME_CHECKED_REASONS: ReadonlySet<string> = new Set(['verify_unavailable']);

/**
 * Every reason that may auto-release. Derived, never hand-listed — a reason
 * has to pick a lane above to get in.
 */
export const AUTO_RELEASE_REASONS: ReadonlySet<string> = new Set([
  ...CONDITION_CHECKED_REASONS,
  ...TIME_CHECKED_REASONS,
]);

/** How long a {@link TIME_CHECKED_REASONS} hold waits before it tries again. */
export const HOLD_RECHECK_MS = 10 * 60_000;

/**
 * Whether a hold for `reason` clears without anyone doing anything.
 *
 * The one predicate every surface that describes a hold must ask, so no copy
 * can promise a resume this module will not perform.
 */
export function holdResumesItself(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && AUTO_RELEASE_REASONS.has(reason);
}

/**
 * Whether holding `job` for `reason` produces a hold that will release itself.
 *
 * Narrower than {@link holdResumesItself}: it also spends the once-per-lineage
 * bound, so a re-hold answers false even for a self-clearing reason.
 */
export function holdAutoReleases(priorPayload: unknown, reason: string): boolean {
  return readHoldState(priorPayload) === null && AUTO_RELEASE_REASONS.has(reason);
}

export function readHoldState(payload: unknown): HoldState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>)[HOLD_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { reason, heldAt, autoRelease } = raw as Record<string, unknown>;
  if (typeof reason !== 'string' || typeof heldAt !== 'string') return null;
  return { reason, heldAt, autoRelease: autoRelease === true };
}

/**
 * Insert the held successor for a job whose retries are spent: its id, or `null` for a reason
 * that is not a hold reason or an insert `jobs_active_unique` refused to a concurrent active job.
 */
export async function holdJobForReason(job: JobRow, reason: string): Promise<string | null> {
  if (!HOLD_REASONS.has(reason)) return null;

  const state: HoldState = {
    reason,
    heldAt: new Date().toISOString(),
    autoRelease: holdAutoReleases(job.payload, reason),
  };
  const basePayload = (job.payload ?? {}) as Record<string, unknown>;
  const retryAfterAt = TIME_CHECKED_REASONS.has(reason)
    ? new Date(Date.now() + HOLD_RECHECK_MS)
    : null;

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

// cm:hack ISS-5 until:no held job carries this reason — its budget gate is gone, so it releases.
const RETIRED_BUDGET_HOLD = 'monthly_budget_exhausted';

async function conditionCleared(job: JobRow, reason: string): Promise<boolean> {
  if (reason === RETIRED_BUDGET_HOLD) return true;
  if (reason === 'all_devices_exhausted') {
    const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
      ?.requiredCapabilities;
    const healthy = await onlineCapableDeviceIds(job.projectId, required);
    return healthy.length > 0;
  }
  return TIME_CHECKED_REASONS.has(reason);
}

/**
 * Turn a held row back into a queued one: the kernel's `held → queued` move, with the columns a
 * requeue resets. Shared by the automatic release below and the operator resume in
 * `resume-job.ts`, so the two produce an IDENTICAL row.
 */
export async function requeueHeldJob(
  exec: KernelExecutor,
  job: JobRow,
  now: Date,
  move: { actor: KernelActor; reason: string; source: string },
): Promise<{ id: string; type: JobType; issueId: string | null } | null> {
  const [row] = (
    await transition(exec, JOB_MACHINE, {
      to: 'queued',
      from: 'held',
      set: requeueColumns(job, now),
      where: eq(jobs.id, job.id),
      reason: move.reason,
      actor: move.actor,
      source: move.source,
      returning: ['id', 'type', 'issueId'],
    })
  ).rows;
  return row ?? null;
}

function requeueColumns(
  job: JobRow,
  now: Date,
): {
  queuedAt: Date;
  retryAfterAt: null;
  failureKind: null;
  failureReason: null;
  payload: Record<string, unknown>;
} {
  const { [AUTO_RETRY_PAYLOAD_KEY]: _spentRotation, ...freshPayload } = (job.payload ??
    {}) as Record<string, unknown>;
  return {
    queuedAt: now,
    retryAfterAt: null,
    failureKind: null,
    failureReason: null,
    payload: {
      ...freshPayload,
      [HOLD_PAYLOAD_KEY]: { ...readHoldState(job.payload), autoRelease: false },
    },
  };
}

/** Clear the requeued job's hold wedge; the pool offers the queued row on the box's next read. */
export async function dispatchRequeuedJob(updated: {
  id: string;
  type: JobType;
  issueId: string | null;
}): Promise<void> {
  await resolvePipelineWedge(updated.id);
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

    const updated = await requeueHeldJob(db, job, now, {
      actor: { type: 'system' },
      reason: `hold condition cleared: ${reason}`,
      source: 'hold-release',
    });
    if (!updated) continue;

    released += 1;
    logger.info({ jobId: job.id, issueId: job.issueId, reason }, 'hold: released to queued');
    await dispatchRequeuedJob(updated);
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
