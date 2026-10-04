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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { heldTakeRefusal, refuseBlockedTake } from '../issues/blocked-by.js';
import { refusalCodeOf } from '../lib/refusal.js';
import {
  assertDispatchGatesForIssue,
  type DispatchGateCode,
} from '../issues/dispatch-gates.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { holdQueuedJob, releaseJobHold } from '../jobs/index.js';
import { resolveJobPolicy } from '../jobs/job-policy.js';
import { poolPrompt, settleNoPromptJob } from '../jobs/pool-served.js';
import {
  canNameItsAgent,
  checkoutUnboundMessage,
  type PreparedJob,
  prepareClaimedJob,
  resolveRunnerForDevice,
} from '../jobs/prepare-claimed-job.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { transition } from '../lifecycle/transition.js';
import type { PolicyRefusalCode } from '@forge/contracts/project-config';
import { logger } from '../logger.js';
import { type DispatchState, policyRefusalOf } from '../project-config/dispatch-policy.js';
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
        | 'hold_lost'
        | 'runner_too_old'
        | 'runner_withdrawn'
        | 'device_disabled'
        | 'runner_unbound'
        | 'release_label_missing'
        | 'no_prompt';
    }
  | {
      ok: false;
      reason: 'policy_refused';
      code: PolicyRefusalCode | DispatchGateCode | 'ISSUE_BLOCKED';
      detail: string;
    }
  | { ok: false; reason: 'checkout_unbound'; detail: string };

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
      'claim: release job refused, a box carrying the project release label is available',
    );
    return { ok: false, reason: 'release_label_missing' };
  }
  if (!releaseLabel.preferenceMet) {
    logger.warn(
      { jobId: args.jobId, deviceId: args.deviceId, releaseRunnerLabel: releaseLabel.label },
      'claim: release job taken by a box that does not carry the declared release label, because no eligible box does',
    );
  }

  const unbound = await checkoutUnbound(args.jobId, args.deviceId);
  if (unbound) return { ok: false, reason: 'checkout_unbound', detail: unbound };

  if (await refusedForNoPrompt(args.jobId)) return { ok: false, reason: 'no_prompt' };

  const policy = await policyStateFor(args.jobId);
  if (!policy.ok) return policy.refusal;

  const design = await designGateFor(args.jobId);
  if (design) return design;

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
      policy: policy.state,
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
 * The policy state a job runs under, read before it is held: a job its project's policy cannot
 * place is refused by name and stays queued, so the refusal repeats until the policy says how.
 */
async function policyStateFor(
  jobId: string,
): Promise<
  { ok: true; state: DispatchState } | { ok: false; refusal: Extract<PrepareResult, { ok: false }> }
> {
  const [job] = await db
    .select({ projectId: jobs.projectId, issueId: jobs.issueId, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return { ok: false, refusal: { ok: false, reason: 'not_found' } };
  try {
    return { ok: true, state: await resolveJobPolicy(job) };
  } catch (err) {
    const refused = policyRefusalOf(err);
    if (!refused) throw err;
    logger.warn({ jobId, projectId: job.projectId, code: refused.code }, refused.detail);
    return {
      ok: false,
      refusal: { ok: false, reason: 'policy_refused', code: refused.code, detail: refused.detail },
    };
  }
}

/**
 * A job for an unstarted issue a live blocks edge holds, one that builds a workflow whose design is
 * not approved, or one that waits on a contract version not yet published, is refused by the policy-refusal shape the box already reads, and stays
 * queued until the design is approved or the version is.
 */
async function designGateFor(jobId: string): Promise<Extract<PrepareResult, { ok: false }> | null> {
  const [job] = await db
    .select({ projectId: jobs.projectId, issueId: jobs.issueId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job?.issueId) return null;
  try {
    await refuseBlockedTake(db, job.issueId, 'a pool job for it');
    await assertDispatchGatesForIssue(job.projectId, job.issueId);
    return null;
  } catch (err) {
    const refused = heldTakeRefusal(err);
    if (!refused) throw err;
    const code = refusalCodeOf(refused) as DispatchGateCode | 'ISSUE_BLOCKED';
    const detail = refused.refusals.map((r) => r.detail).join(' ');
    logger.warn({ jobId, projectId: job.projectId, code }, detail);
    return { ok: false, reason: 'policy_refused', code, detail };
  }
}

/**
 * The device binding is where a job runs: a binding that names no checkout is refused by name
 * before the job is held, so the box is told to bind one rather than handed work with no cwd.
 */
async function checkoutUnbound(jobId: string, deviceId: string): Promise<string | null> {
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return null;
  const binding = await resolveRunnerForDevice(job.projectId, deviceId);
  return binding.repoPath ? null : checkoutUnboundMessage(job.projectId, deviceId, binding.id);
}

/**
 * A queued, unheld job the pool cannot brief is refused before it is held, and
 * settled where it stands — given back instead, it would head its project's
 * pool on every pass and nothing behind it would be reached.
 */
async function refusedForNoPrompt(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ id: jobs.id, type: jobs.type, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued'), isNull(jobs.heldBy)))
    .limit(1);
  if (!job || poolPrompt(job.payload) !== null) return false;
  return settleNoPromptJob(job);
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

