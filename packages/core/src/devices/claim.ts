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

import type { PoolClaimRefusalCode } from '@forge/contracts/devices';
import type { DispatchState } from '@forge/contracts/project-config';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import {
  activeIssuePrefix,
  assertContractWaitsSettledForIssue,
  assertDesignApprovedForIssue,
  assertPatternReviewsSettledForIssue,
  type DispatchGateCode,
  heldTakeRefusal,
  refuseBlockedTake,
} from '../issues/index.js';
import {
  canNameItsAgent,
  checkoutUnboundMessage,
  dispatchHeldJob,
  type HoldRefusal,
  holdQueuedJob,
  type PreparedJob,
  poolPrompt,
  prepareClaimedJob,
  releaseJobHold,
  resolveJobPolicy,
  resolveRunnerForDevice,
  settleNoPromptJob,
} from '../jobs/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { type RefusalError, refusalCodeOf } from '../lib/refusal.js';
import { releaseLabelAllows } from '../runners/index.js';
import { masterSessionOnDevice } from './master-session.js';
import { runnerAdmission } from './pool-admission.js';
import { devicesPorts } from './ports.js';
import { refuseDevice } from './refusals.js';

type JobRow = typeof jobs.$inferSelect;

type PrepareResult = {
  ok: true;
  jobId: string;
  issueKey: string | null;
  prepared: PreparedJob;
};

type StartResult = { ok: true };

/** A hold or stamp jobs refused, as the pool code the box reads back as its reason. */
function holdRefused(jobId: string, refused: HoldRefusal, after: string): RefusalError {
  switch (refused.reason) {
    case 'run_paused':
    case 'run_not_running':
      return refusePool(
        refused.reason === 'run_paused' ? 'POOL_RUN_PAUSED' : 'POOL_RUN_NOT_RUNNING',
        `job ${jobId} belongs to a run that is ${refused.runStatus}, and a run dispatches only while it is running; resume the run first.${after}`,
      );
    case 'not_found':
      return refusePool('POOL_NOT_FOUND', `no job ${jobId}`);
    case 'already_held':
      return refusePool('POOL_ALREADY_HELD', `job ${jobId} was taken or started by another holder`);
    case 'issue_busy':
      return refusePool(
        'POOL_ISSUE_BUSY',
        `another step for job ${jobId}'s issue is already dispatched or held`,
      );
    case 'hold_lost':
      return refusePool(
        'POOL_HOLD_LOST',
        `job ${jobId} is no longer held by this session, so it was not started`,
      );
  }
}

const HOLD_LOST = (args: { jobId: string; sessionId: string }) =>
  `job ${args.jobId} is no longer held by session ${args.sessionId}, so it was not started`;

/** The refusal a claim answers with: the box reads the code back as its reason (`contracts/devices`). */
function refusePool(code: PoolClaimRefusalCode, detail: string): RefusalError {
  return refuseDevice(code, detail);
}

const ADMISSION_REFUSAL = {
  runner_unbound: 'POOL_RUNNER_UNBOUND',
  device_disabled: 'POOL_DEVICE_DISABLED',
  runner_withdrawn: 'POOL_RUNNER_WITHDRAWN',
} as const satisfies Record<string, PoolClaimRefusalCode>;

const RUNNER_TOO_OLD =
  'this runner build cannot name the agent a job runs as; update forge-runner before it takes pool work';

/**
 * The master session a claim names, refused by name unless it is a live master on the calling box,
 * and of the job's project where one is given: a session id in a body is a claim, never the record.
 */
export async function assertMasterSessionHeld(args: {
  deviceId: string;
  sessionId: string;
  projectId?: string;
  live: boolean;
}): Promise<void> {
  const held = await masterSessionOnDevice(args);
  if (held) return;
  throw refuseDevice(
    'MASTER_SESSION_NOT_HELD',
    `session ${args.sessionId} is not ${args.live ? 'a live' : 'a'} master session on this box` +
      `${args.projectId ? ` for project ${args.projectId}` : ''}, so nothing was taken or given back. ` +
      'Send the master session core issued to this box (`POST /api/devices/me/master-session`).',
    '/sessionId',
  );
}

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
  if (!(await canNameItsAgent(args.deviceId)))
    throw refusePool('POOL_RUNNER_TOO_OLD', RUNNER_TOO_OLD);

  const admission = await runnerAdmission({ jobId: args.jobId, deviceId: args.deviceId });
  if (!admission.admitted) {
    throw refusePool(
      ADMISSION_REFUSAL[admission.reason],
      `job ${args.jobId} is not admitted on this box: ${admission.reason}`,
    );
  }

  if (!(await releaseLabelAllows(args))) {
    throw refusePool(
      'POOL_RELEASE_LABEL_MISSING',
      `job ${args.jobId} needs a release label this box's runner does not carry`,
    );
  }

  const [job] = await db.select().from(jobs).where(eq(jobs.id, args.jobId)).limit(1);
  if (!job) throw refusePool('POOL_NOT_FOUND', `no job ${args.jobId}`);

  await assertMasterSessionHeld({
    deviceId: args.deviceId,
    sessionId: args.sessionId,
    projectId: job.projectId,
    live: true,
  });

  const binding = await resolveRunnerForDevice(job.projectId, args.deviceId);
  if (!binding.repoPath) {
    throw refusePool(
      'POOL_CHECKOUT_UNBOUND',
      checkoutUnboundMessage(job.projectId, args.deviceId, binding.id),
    );
  }

  if (await refusedForNoPrompt(job)) {
    throw refusePool('POOL_NO_PROMPT', `job ${args.jobId} carries no prompt the pool can brief`);
  }

  const policy = await policyStateFor(job);
  await designGateFor(job);

  const claimed = await db.transaction(async (tx) => {
    const hold = await holdQueuedJob(tx, args.jobId, args.sessionId);
    if (!hold.ok) return hold;
    const keyRows = hold.job.issueId
      ? ((await tx.execute(sql`
          SELECT i.iss_seq FROM issues i WHERE i.id = ${hold.job.issueId} LIMIT 1
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    return {
      ok: true,
      job: hold.job,
      issSeq: (keyRows[0]?.iss_seq as number | null) ?? null,
    } as const;
  });
  if (!claimed.ok) throw holdRefused(args.jobId, claimed, '');

  let prepared: PreparedJob;
  try {
    prepared = await prepareClaimedJob({
      jobId: claimed.job.id,
      deviceId: args.deviceId,
      policy,
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
async function policyStateFor(job: JobRow): Promise<DispatchState> {
  try {
    return await resolveJobPolicy(job);
  } catch (err) {
    const refused = devicesPorts().policyRefusalOf(err);
    if (!refused) throw err;
    logger.warn({ jobId: job.id, projectId: job.projectId, code: refused.code }, refused.detail);
    throw refusePool('POOL_POLICY_REFUSED', `${refused.code}: ${refused.detail}`);
  }
}

/**
 * A job for an unstarted issue a live blocks edge holds, one that builds a workflow whose design is
 * not approved, one that waits on a contract version no approved version settles, or one that names a new pattern no reviewer has
 * decided, is refused by the policy-refusal shape the box already reads, and stays queued until the design, the version or the
 * pattern is approved.
 */
async function designGateFor(job: JobRow): Promise<void> {
  if (!job.issueId) return;
  try {
    await refuseBlockedTake(db, job.issueId, 'a pool job for it');
    await assertDesignApprovedForIssue(job.projectId, job.issueId);
    await assertContractWaitsSettledForIssue(job.projectId, job.issueId);
    await assertPatternReviewsSettledForIssue(job.projectId, job.issueId);
  } catch (err) {
    const refused = heldTakeRefusal(err);
    if (!refused) throw err;
    const code = refusalCodeOf(refused) as DispatchGateCode | 'ISSUE_BLOCKED';
    const detail = refused.refusals.map((r) => r.detail).join(' ');
    logger.warn({ jobId: job.id, projectId: job.projectId, code }, detail);
    throw refusePool('POOL_POLICY_REFUSED', `${code}: ${detail}`);
  }
}

/**
 * A queued, unheld job the pool cannot brief is refused before it is held, and
 * settled where it stands — given back instead, it would head its project's
 * pool on every pass and nothing behind it would be reached.
 */
async function refusedForNoPrompt(job: JobRow): Promise<boolean> {
  if (job.status !== 'queued' || job.heldBy !== null || poolPrompt(job.payload) !== null)
    return false;
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
  if (!(await canNameItsAgent(args.deviceId)))
    throw refusePool('POOL_RUNNER_TOO_OLD', RUNNER_TOO_OLD);
  await assertMasterSessionHeld({ deviceId: args.deviceId, sessionId: args.sessionId, live: true });
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .limit(1);
  if (!job) throw refusePool('POOL_HOLD_LOST', HOLD_LOST(args));
  const runner = await resolveRunnerForDevice(job.projectId, args.deviceId);

  const stamped = await dispatchHeldJob({ ...args, runnerId: runner.id });
  if (!stamped.ok) {
    // a paused run's job goes back to the pool; one under a closed run is settled cancelled
    await releaseJobHold(args.jobId, args.sessionId);
    throw holdRefused(args.jobId, stamped, ' Its hold was given back.');
  }
  return { ok: true };
}
