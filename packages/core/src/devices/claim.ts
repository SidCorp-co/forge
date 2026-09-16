/**
 * A master agent taking one job, and the kernel recording that it did.
 *
 * The routing decision is the master's and is not re-litigated here. What this
 * owns is the part that must hold when the master is gone: one holder per job,
 * one in-flight step per issue, and a hold that is given back on every path
 * that fails after it lands.
 *
 * Taking and starting are TWO acts (ISS-919 B2). `prepareJobForMaster` mints
 * the token and builds the work while the job stays `queued` and HELD;
 * `startJobForMaster` is the stamp, and the stamp is what ends the hold. A
 * master that prepares and never starts is covered by the release rule that
 * already existed — `releaseJobFromMaster`, or the three-minute reaper — which
 * is the whole reason the split lands on this side of the stamp rather than
 * after it.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { jobs } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { endJobForBudgetBreach } from '../jobs/budget-breach.js';
import { checkMonthlyBudget, shouldEmitWarn } from '../jobs/budget-check.js';
import {
  canNameItsAgent,
  type PreparedJob,
  prepareClaimedJob,
  resolveRunnerForDevice,
} from '../jobs/prepare-claimed-job.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { runnerAdmission } from './pool-admission.js';
import { releaseLabelVerdict } from './release-label.js';

export type PrepareResult =
  | {
      ok: true;
      jobId: string;
      issueKey: string | null;
      prepared: PreparedJob;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_held'
        | 'issue_busy'
        | 'budget_exhausted'
        | 'hold_lost'
        | 'runner_too_old'
        | 'runner_withdrawn'
        | 'device_disabled'
        | 'runner_unbound'
        | 'release_label_missing';
    };

export type StartResult = { ok: true } | { ok: false; reason: 'hold_lost' | 'runner_too_old' };

/**
 * Take one queued job for `sessionId` on `deviceId` and build the work, WITHOUT
 * starting anything.
 *
 * Refuses when another step for the same issue is already in flight, and when
 * a job was taken by whoever asked first. On success the job is still `queued`
 * and now HELD: the caller owes either a `startJobForMaster` or a release.
 */
export async function prepareJobForMaster(args: {
  jobId: string;
  deviceId: string;
  sessionId: string;
}): Promise<PrepareResult> {
  if (!(await canNameItsAgent(args.deviceId))) {
    return { ok: false, reason: 'runner_too_old' };
  }

  const admission = await runnerAdmission({ jobId: args.jobId, deviceId: args.deviceId });
  if (!admission.admitted) {
    return { ok: false, reason: admission.reason };
  }

  const releaseLabel = await releaseLabelVerdict({ jobId: args.jobId, deviceId: args.deviceId });
  if (!releaseLabel.allowed) {
    logger.warn(
      { jobId: args.jobId, deviceId: args.deviceId, ...releaseLabel },
      'claim: release job refused, this box does not carry the project release label',
    );
    return { ok: false, reason: 'release_label_missing' };
  }

  const claimed = await db.transaction(async (tx) => {
    const held = await tx
      .update(jobs)
      .set({ heldBy: args.sessionId, heldAt: sql`now()` })
      .where(
        and(
          eq(jobs.id, args.jobId),
          eq(jobs.status, 'queued'),
          isNull(jobs.heldBy),
          sql`NOT EXISTS (
            SELECT 1 FROM jobs other
            WHERE other.issue_id = jobs.issue_id
              AND other.id <> jobs.id
              AND other.status IN ('dispatched','running','held')
          )`,
        ),
      )
      .returning();

    const row = held[0];
    if (!row) {
      const diag = (await tx.execute(sql`
        SELECT j.held_by IS NOT NULL OR j.status <> 'queued' AS taken,
               EXISTS (SELECT 1 FROM jobs o
                       WHERE o.issue_id = j.issue_id AND o.id <> j.id
                         AND o.status IN ('dispatched','running','held')) AS busy
        FROM jobs j WHERE j.id = ${args.jobId} LIMIT 1
      `)) as unknown as Array<Record<string, unknown>>;
      const d = diag[0];
      if (!d) return { kind: 'not_found' } as const;
      return { kind: d.taken ? 'already_held' : 'issue_busy' } as const;
    }

    const keyRows = row.issueId
      ? ((await tx.execute(sql`
          SELECT i.iss_seq FROM issues i WHERE i.id = ${row.issueId} LIMIT 1
        `)) as unknown as Array<Record<string, unknown>>)
      : [];

    return {
      kind: 'held',
      job: row,
      issSeq: (keyRows[0]?.iss_seq as number | null) ?? null,
    } as const;
  });

  if (claimed.kind !== 'held') return { ok: false, reason: claimed.kind };

  const budget = await checkMonthlyBudget(claimed.job);
  if (budget.action === 'pause') {
    await releaseJobFromMaster({ jobId: claimed.job.id, sessionId: args.sessionId });
    await endJobForBudgetBreach(claimed.job, budget);
    return { ok: false, reason: 'budget_exhausted' };
  }
  if (
    budget.action === 'warn-80' &&
    budget.stageStatus !== null &&
    shouldEmitWarn(claimed.job.projectId, budget.stageStatus)
  ) {
    await hooks.emit('pipeline.budgetWarning', {
      projectId: claimed.job.projectId,
      stageStatus: budget.stageStatus,
      jobType: claimed.job.type,
      spent: budget.spent,
      budget: budget.budget ?? 0,
      pct: budget.budget && budget.budget > 0 ? budget.spent / budget.budget : 0,
    });
  }

  let prepared: PreparedJob;
  try {
    prepared = await prepareClaimedJob({ jobId: claimed.job.id, deviceId: args.deviceId });
  } catch (err) {
    await releaseJobFromMaster({ jobId: claimed.job.id, sessionId: args.sessionId });
    throw err;
  }

  return {
    ok: true,
    jobId: claimed.job.id,
    issueKey:
      claimed.issSeq == null
        ? null
        : formatIssueRef(await activeIssuePrefix(claimed.job.projectId), claimed.issSeq),
    prepared,
  };
}

/**
 * The second act: hand the prepared job over to the process about to run it.
 *
 * Called when the runner has a session for the job and is committed to
 * spawning it. Until this lands the job is plain `queued` and held, which is
 * the state every existing release path already knows how to undo.
 */
export async function startJobForMaster(args: {
  jobId: string;
  deviceId: string;
  sessionId: string;
}): Promise<StartResult> {
  if (!(await canNameItsAgent(args.deviceId))) {
    return { ok: false, reason: 'runner_too_old' };
  }
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .limit(1);
  if (!job) return { ok: false, reason: 'hold_lost' };
  const runner = await resolveRunnerForDevice(job.projectId, args.deviceId);

  const stamped = await withKernelMarker(db, async (tx) =>
    tx
      .update(jobs)
      .set({
        status: 'dispatched',
        deviceId: args.deviceId,
        runnerId: runner.id,
        dispatchedAt: new Date(),
        heldBy: null,
        heldAt: null,
      })
      .where(
        and(eq(jobs.id, args.jobId), eq(jobs.status, 'queued'), eq(jobs.heldBy, args.sessionId)),
      )
      .returning({ id: jobs.id }),
  );
  if (!stamped.length) {
    await releaseJobFromMaster({ jobId: args.jobId, sessionId: args.sessionId });
    return { ok: false, reason: 'hold_lost' };
  }
  return { ok: true };
}

/** Give a held job back to the pool. */
export async function releaseJobFromMaster(args: {
  jobId: string;
  sessionId: string;
}): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Release every job a dead master was holding.
 *
 * Only the hold moves. Anything this master actually started is no longer
 * held at all, so a running job is not reachable from here.
 */
export async function releaseAllHeldBySession(sessionId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(eq(jobs.heldBy, sessionId))
    .returning({ id: jobs.id });
  return rows.length;
}
