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
 * already existed — `jobs/master-holds.ts:releaseJobHold`, or the three-minute reaper — which
 * is the whole reason the split lands on this side of the stamp rather than
 * after it.
 */

import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import {
  canNameItsAgent,
  holdQueuedJob,
  type PreparedJob,
  prepareClaimedJob,
  releaseJobHold,
  resolveRunnerForDevice,
} from '../jobs/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { transition } from '../lifecycle/index.js';
import { gateJobForMaster, type PrepareRefusal } from './claim-gates.js';

type PrepareResult =
  | { ok: true; jobId: string; issueKey: string | null; prepared: PreparedJob }
  | PrepareRefusal;

type StartResult = { ok: true } | { ok: false; reason: 'hold_lost' | 'runner_too_old' };

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
  const gate = await gateJobForMaster(args);
  if (!gate.ok) return gate;

  const claimed = await db.transaction(async (tx) => {
    const row = await holdQueuedJob(tx, args.jobId, args.sessionId);
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

  let prepared: PreparedJob;
  try {
    prepared = await prepareClaimedJob({
      jobId: claimed.job.id,
      deviceId: args.deviceId,
      policy: gate.policy,
    });
  } catch (err) {
    await releaseJobHold(claimed.job.id, args.sessionId);
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

  const stamped = (
    await transition(db, JOB_MACHINE, {
      to: 'dispatched',
      from: 'queued',
      set: {
        deviceId: args.deviceId,
        runnerId: runner.id,
        dispatchedAt: new Date(),
        heldBy: null,
        heldAt: null,
      },
      where: and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)),
      actor: { type: 'runner', id: args.deviceId },
      source: 'claim',
      returning: ['id'],
    })
  ).rows;
  if (!stamped.length) {
    await releaseJobHold(args.jobId, args.sessionId);
    return { ok: false, reason: 'hold_lost' };
  }
  return { ok: true };
}
