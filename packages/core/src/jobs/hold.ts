import { JOB_MACHINE } from '@forge/contracts/job-machine';
import {
  AUTO_RELEASE_REASONS,
  AUTO_RETRY_PAYLOAD_KEY,
  HOLD_PAYLOAD_KEY,
  type HoldState,
  holdReleasesItself,
  readHoldState,
  TIME_CHECKED_REASONS,
} from '@forge/contracts/jobs';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../lib/logger.js';
import { type KernelActor, type KernelExecutor, transition } from '../lifecycle/index.js';
import { resolvePipelineWedge } from '../pipeline/index.js';
import { onlineCapableDeviceIds, type RequiredCapabilities } from '../runners/index.js';

export {
  AUTO_RELEASE_REASONS,
  HOLD_PAYLOAD_KEY,
  type HoldState,
  holdReleasesItself,
  readHoldState,
} from '@forge/contracts/jobs';

type JobRow = typeof jobs.$inferSelect;

const HOLD_REASONS: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'verify_unavailable',
]);

/** How long a {@link TIME_CHECKED_REASONS} hold waits before it tries again. */
const HOLD_RECHECK_MS = 10 * 60_000;

/**
 * Whether holding `job` for `reason` produces a hold that will release itself: a self-clearing
 * reason on a lineage that has not been held before, so a re-hold answers false.
 */
export function holdAutoReleases(priorPayload: unknown, reason: string): boolean {
  return readHoldState(priorPayload) === null && AUTO_RELEASE_REASONS.has(reason);
}

/**
 * Insert the held successor for a job whose retries are spent. `null` for a reason that is not a
 * hold reason; `superseded` when `jobs_active_unique` refused it because another active job of
 * the same issue and type exists, which still carries the run. Any other insert error throws.
 */
export async function holdJobForReason(
  job: JobRow,
  reason: string,
): Promise<{ heldId: string } | 'superseded' | null> {
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
    if (!created) throw new Error(`hold: successor insert for job ${job.id} returned no row`);
    logger.info(
      { jobId: created.id, heldFrom: job.id, issueId: job.issueId, ...state },
      'hold: job held',
    );
    return { heldId: created.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    logger.warn({ jobId: job.id, reason }, 'hold: another active job of this issue holds the slot');
    return 'superseded';
  }
}

/**
 * The kernel's `held → queued` move (`hold.released`), with the columns a requeue resets: a fresh
 * rotation, and the lineage's one auto-release spent so a second hold is a person's.
 */
export async function requeueHeldJob(
  exec: KernelExecutor,
  job: JobRow,
  move: { actor: KernelActor; reason: string; source: string },
): Promise<{ id: string; issueId: string | null } | null> {
  const { [AUTO_RETRY_PAYLOAD_KEY]: _spentRotation, ...payload } = (job.payload ?? {}) as Record<
    string,
    unknown
  >;
  const [row] = (
    await transition(exec, JOB_MACHINE, {
      to: 'queued',
      from: 'held',
      set: {
        queuedAt: new Date(),
        retryAfterAt: null,
        failureKind: null,
        failureReason: null,
        payload: {
          ...payload,
          [HOLD_PAYLOAD_KEY]: { ...readHoldState(job.payload), autoRelease: false },
        },
      },
      where: eq(jobs.id, job.id),
      reason: move.reason,
      actor: move.actor,
      source: move.source,
      returning: ['id', 'issueId'],
    })
  ).rows;
  if (row) await resolvePipelineWedge(row.id);
  return row ?? null;
}

/** Whether a self-clearing hold's condition has cleared: a capable box is free, or the wait is over. */
async function conditionCleared(job: JobRow, reason: string): Promise<boolean> {
  if (reason !== 'all_devices_exhausted') return TIME_CHECKED_REASONS.has(reason);
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  return (await onlineCapableDeviceIds(job.projectId, required)).length > 0;
}

/**
 * The release sweep: every held job whose hold releases itself and whose condition has cleared
 * goes back to `queued`. A hold that does not release itself waits for a person's resume.
 */
export async function releaseHeldJobs(): Promise<{ released: number }> {
  const candidates = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'held'),
        or(isNull(jobs.retryAfterAt), lte(jobs.retryAfterAt, new Date())),
      ),
    );
  let released = 0;
  for (const job of candidates) {
    const state = readHoldState(job.payload);
    if (!holdReleasesItself(state, job.failureReason)) continue;
    const reason = state?.reason ?? job.failureReason ?? '';
    try {
      if (!(await conditionCleared(job, reason))) continue;
      const row = await requeueHeldJob(db, job, {
        actor: { type: 'system' },
        reason: `hold condition cleared: ${reason}`,
        source: 'hold-release',
      });
      if (row) released += 1;
    } catch (err) {
      logger.error({ err, jobId: job.id, reason }, 'hold: release failed, staying held');
    }
  }
  return { released };
}
