// Resolves, for one dispatch, THREE coupled decisions that used to sit inline in
// `dispatchViaRunner`: whether to resume a prior Claude CLI session, which device to pin, and
// which devices to exclude. They are coupled because dropping a resume must also drop the pin
// that only existed to reach that session's file — three call sites got that pairing right
// inline, and a fourth would eventually not.
//
// ISS-887 — every path that declines a resume names itself in one vocabulary (`ResumeDropReason`),
// and the answer travels out on `ResumePolicy.record` so the attempt's own `agent_sessions` row
// can say whether it continued the prior transcript and, when it did not, why. The answer this
// function returns is PROVISIONAL: one path (`pin_stale`) is only observable after a device has
// been picked, so `finalizeResumeForDevice` at the bottom is the exit that settles it.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { recordResumeDrop } from '../observability/hold-metrics.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { AUTONOMOUS_JOB_TYPE } from '../pipeline/autonomous-mode.js';
import { getTrippedDeviceIds } from '../runners/select.js';
import { readAutoRetryPayload } from './retry.js';
import {
  estimateGroupContextTokens,
  findPriorSessionInGroup,
  loadResumeBounds,
} from './session-resume.js';
import { extractStageStatus, type StageOverrides } from './stage-overrides.js';

/**
 * Why a dispatch that HAD a prior session to continue started from an empty transcript instead.
 *
 * "No prior session existed" is not a member: it is the normal shape of a first attempt and
 * counting it would drown the losses that matter. `ResumeRecord.dropReason === null` with
 * `priorClaudeSessionId === null` is that case.
 */
export type ResumeDropReason =
  | 'stage_pool'
  | 'resume_bound_tokens'
  | 'resume_bound_reopen_cycles'
  | 'device_tripped'
  | 'rotation'
  | 'failure_action'
  | 'pin_stale';

/** What this attempt did with the prior session, durable on `agent_sessions.metadata.resume`. */
export interface ResumeRecord {
  resumed: boolean;
  dropReason: ResumeDropReason | null;
  /** The session this attempt was OFFERED — present whether it was taken or dropped. */
  priorClaudeSessionId: string | null;
  /** The box holding that session's CLI file; `null` when the prior session recorded no device. */
  priorDeviceId: string | null;
  pinDeviceId: string | null;
  /** The PARENT attempt's classified action on a retry (`failover` is the common loser). */
  failureAction: string | null;
}

export interface ResumePolicy {
  priorClaudeSessionId: string | null;
  pinDeviceId: string | null;
  excludeDeviceIds: string[];
  skipPrimary: boolean;
  isRetry: boolean;
  record: ResumeRecord;
}

/**
 * The parent attempt a retry could continue: its CLI session, the box holding that session's
 * file, and the action the classifier gave the failure.
 *
 * `findPriorSessionInGroup` cannot answer this: it filters `status='completed'`, and a retry's
 * parent is `failed` by definition. So this reaches the parent through the retry chain rather
 * than through the session group.
 */
// cm:guard `deviceId` and `failureAction` must come off the PARENT rows this reads, never off the `job` argument: `retry.ts` clones neither column and `claimRunnerSlot` stamps `device_id` only at dispatch — AFTER this runs — so both are NULL on every queued retry, and the same-box resume window below was unreachable in production until 2026-08-30 because it compared them against the child.
async function loadParentAttempt(job: typeof jobs.$inferSelect): Promise<{
  claudeSessionId: string;
  deviceId: string | null;
  failureAction: string | null;
} | null> {
  if (!job.retryOf) return null;
  try {
    const [parentJob] = await db
      .select({ agentSessionId: jobs.agentSessionId, failureAction: jobs.failureAction })
      .from(jobs)
      .where(eq(jobs.id, job.retryOf))
      .limit(1);
    if (!parentJob?.agentSessionId) return null;
    const [row] = await db
      .select({
        claudeSessionId: agentSessions.claudeSessionId,
        deviceId: agentSessions.deviceId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, parentJob.agentSessionId))
      .limit(1);
    if (!row?.claudeSessionId) return null;
    return {
      claudeSessionId: row.claudeSessionId,
      deviceId: row.deviceId,
      failureAction: parentJob.failureAction ?? null,
    };
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, retryOf: job.retryOf },
      'resume-policy: parent-attempt lookup failed, dispatching fresh',
    );
    return null;
  }
}

/** ISS-580 — drop the resume when the group's accumulated context or the issue's reopen count
 *  has outgrown its configured bound. Returns the drop reason, or null when both bounds hold. */
async function exceedsResumeBounds(args: {
  job: typeof jobs.$inferSelect;
  issueId: string;
  sessionGroup: string;
  agentConfig: Record<string, unknown> | undefined;
}): Promise<ResumeDropReason | null> {
  const bounds = await loadResumeBounds(args.job.projectId, args.agentConfig);
  const estTokens = await estimateGroupContextTokens({
    issueId: args.issueId,
    sessionGroup: args.sessionGroup,
  });
  let reopenCount = 0;
  try {
    const [issueRow] = await db
      .select({ reopenCount: issues.reopenCount })
      .from(issues)
      .where(eq(issues.id, args.issueId))
      .limit(1);
    reopenCount = issueRow?.reopenCount ?? 0;
  } catch (err) {
    logger.warn(
      { err, jobId: args.job.id, issueId: args.issueId },
      'resume-policy: failed to read reopenCount, treating as 0',
    );
  }
  const overTokens = bounds.maxResumeTokens > 0 && estTokens > bounds.maxResumeTokens;
  const overCycles = bounds.maxResumeReopenCycles > 0 && reopenCount > bounds.maxResumeReopenCycles;
  if (!overTokens && !overCycles) return null;
  const reason: ResumeDropReason = overTokens
    ? 'resume_bound_tokens'
    : 'resume_bound_reopen_cycles';
  logger.info(
    {
      jobId: args.job.id,
      issueId: args.issueId,
      sessionGroup: args.sessionGroup,
      estTokens,
      reopenCount,
      maxResumeTokens: bounds.maxResumeTokens,
      maxResumeReopenCycles: bounds.maxResumeReopenCycles,
      reason,
    },
    'resume-policy: sessionGroup resume bound exceeded — dispatching fresh session',
  );
  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'pipeline.resume_bound',
      data: { reason, estTokens, reopenCount },
    });
  }
  return reason;
}

/**
 * Device selection splits cleanly into two cases (`jobs/retry.ts` owns the retry side):
 *
 *   - FIRST dispatch (`job.retryOf == null`): primary-pinned, plus the circuit breaker so it
 *     doesn't land on a known-bad device. The selector's wrap-around still probes a tripped
 *     device when EVERY device is tripped, so a single-device project never wedges.
 *   - RETRY: the uniform round-robin drives it — pin the rotation `target`, exclude the devices
 *     already `done` this round, `skipPrimary` so no device gets preferential treatment. The
 *     circuit breaker is intentionally NOT applied: the round-robin already cycles devices
 *     fairly, and layering the breaker on top would fight it (a device tripped after its 3 tries
 *     would be skipped for the rest of the chain instead of getting its turn next round).
 */
export async function resolveResumePolicy(args: {
  job: typeof jobs.$inferSelect;
  overrides: StageOverrides;
  agentConfig: Record<string, unknown> | undefined;
}): Promise<ResumePolicy> {
  const { job, overrides } = args;
  const stagePool = overrides.deviceIds;
  let offeredClaudeSessionId: string | null = null;
  let offeredDeviceId: string | null = null;
  let parentFailureAction: string | null = null;
  let dropReason: ResumeDropReason | null = null;
  let pinDeviceId: string | null = null;

  const isRetry = job.retryOf != null;

  // cm:guard a drive job must never inherit a staged step's CLI session: it resumes through `forge_phase` action `resume_point`, and --resume onto a stale triage session would hand the driver another step's transcript as its own history
  // cm:why gated on `!isRetry` alongside the bound check below: the retry branch replaces every value this block produces (`offeredClaudeSessionId`, `offeredDeviceId`, `pinDeviceId`) and resets `dropReason` to null before any of them is observed, so on a retry the group lookup is a DB query whose entire result is discarded — and its log line asserts a resume decision that never bore on the dispatch
  if (!isRetry && overrides.sessionGroup && job.issueId && job.type !== AUTONOMOUS_JOB_TYPE) {
    const prior = await findPriorSessionInGroup({
      issueId: job.issueId,
      sessionGroup: overrides.sessionGroup,
    });
    if (prior) {
      offeredClaudeSessionId = prior.claudeSessionId;
      offeredDeviceId = prior.deviceId;
      pinDeviceId = prior.deviceId;
    }
  }

  // cm:why the stage pool outranks the session-group resume pin: a resume is an optimisation, but "this stage ran on the box the operator pinned" is the guarantee the pool exists to make — so a prior session on an out-of-pool box loses BOTH the pin and the --resume (same shape as the stale-pin path below)
  if (stagePool && pinDeviceId && !stagePool.includes(pinDeviceId)) {
    logger.info(
      { jobId: job.id, pinDeviceId, stagePool, stageStatus: extractStageStatus(job.payload) },
      'resume-policy: session-group resume pin is outside the stage runner pool — dispatching fresh inside the pool',
    );
    pinDeviceId = null;
    dropReason = 'stage_pool';
  }

  // cm:why gated on `!isRetry` because the retry branch below decides its own resume — running the 3-query bound check here would spend three queries and emit a resume-drop count plus a Sentry breadcrumb describing a resume that was never on the table
  if (!isRetry && !dropReason && offeredClaudeSessionId && overrides.sessionGroup && job.issueId) {
    dropReason = await exceedsResumeBounds({
      job,
      issueId: job.issueId,
      sessionGroup: overrides.sessionGroup,
      agentConfig: args.agentConfig,
    });
    if (dropReason) pinDeviceId = null;
  }

  const autoRetry = readAutoRetryPayload(job.payload);
  let excludeDeviceIds: string[];
  let skipPrimary: boolean;

  if (isRetry) {
    skipPrimary = true;
    excludeDeviceIds = autoRetry.done;
    pinDeviceId = autoRetry.target;
    // cm:why a rotation target computed before the pool was configured (or from a wider fleet) is dropped rather than honoured — selection then picks a standby INSIDE the pool instead of returning null and stalling the retry chain
    let targetOutOfPool = false;
    if (stagePool && pinDeviceId && !stagePool.includes(pinDeviceId)) {
      pinDeviceId = null;
      targetOutOfPool = true;
    }
    // cm:why the session-group offer resolved above is discarded here rather than merged: the guard below lets a retry continue only its OWN parent attempt, so the group's candidate decided nothing and recording ITS drop reason would name a loss that never bore on this dispatch
    const parent = await loadParentAttempt(job);
    offeredClaudeSessionId = parent?.claudeSessionId ?? null;
    offeredDeviceId = parent?.deviceId ?? null;
    parentFailureAction = parent?.failureAction ?? null;
    dropReason = null;
    // cm:guard a retry may resume ONLY when the rotation kept it on the parent attempt's box AND the parent's failure was classified `retry`. `nextRotation` rule 1 stays on one device for RETRY_TRIES_PER_DEVICE tries, and the CLI session file lives on that box — so this is the one case where the file is still reachable. A target elsewhere, or a parent that recorded no box at all, must drop the resume: the file is not there, and `--resume` onto a missing id costs a whole attempt. `failover`/`quarantine`/`terminal` never resume — failover exists to leave the box, and quarantine to condemn it.
    if (parent) {
      if (targetOutOfPool) dropReason = 'stage_pool';
      else if (pinDeviceId === null || pinDeviceId !== parent.deviceId) dropReason = 'rotation';
      else if (parent.failureAction !== 'retry') dropReason = 'failure_action';
    }
  } else {
    skipPrimary = false;
    const trippedDeviceIds = await getTrippedDeviceIds(job.projectId);
    excludeDeviceIds = trippedDeviceIds;
    if (trippedDeviceIds.length > 0) {
      logger.warn(
        { jobId: job.id, projectId: job.projectId, trippedDeviceIds },
        'resume-policy: device circuit breaker tripped — rotating away from failing device(s)',
      );
    }
    if (pinDeviceId && excludeDeviceIds.includes(pinDeviceId)) {
      pinDeviceId = null;
      if (offeredClaudeSessionId) dropReason = 'device_tripped';
    }
  }

  const priorClaudeSessionId = dropReason === null ? offeredClaudeSessionId : null;

  return {
    priorClaudeSessionId,
    pinDeviceId,
    excludeDeviceIds,
    skipPrimary,
    isRetry,
    record: {
      resumed: priorClaudeSessionId !== null,
      dropReason,
      priorClaudeSessionId: offeredClaudeSessionId,
      priorDeviceId: offeredDeviceId,
      pinDeviceId,
      failureAction: parentFailureAction,
    },
  };
}

/**
 * ISS-887 — the resume decision is not final until a device has been chosen.
 *
 * `resolveResumePolicy` runs BEFORE `selectRunnerForJob`, so it can only propose a pin. Step 1 of
 * `pickRunner` returns null when the pinned runner is offline, stale or incapable and falls
 * through to primary/standby — the job lands on a box that does not hold the prior session's CLI
 * file. Until this ran, nothing re-read the session id afterwards: it reached the runner payload
 * anyway and the attempt's row recorded `resumed: true`, so the one path that could still be
 * caught at dispatch time was the one that claimed a continuation instead of reporting a loss.
 */
// cm:guard the counter and the durable record are derived from ONE `dropReason`, at this single exit — `resolveResumePolicy` deliberately increments nothing, because its answer is provisional until the device is known. A second increment beside any drop site, or a caller that stamps `policy.record` without coming through here, is how a rate and an attempt's own row come to disagree about the same dispatch (`measured-together-never-apart`).
// cm:guard `reachable` demands PROOF, not the absence of a mismatch: both ids non-null AND equal. An offer carried on a null pin is the same unreachable file as a mismatched one — `findPriorSessionInGroup` does not filter `device_id IS NOT NULL`, so a prior session that recorded no box would otherwise be dispatched unpinned, land anywhere, and record `resumed: true`. Measured 2026-08-31: 0 of 5,210 such rows and 0 of 64 runners carry a null device, so this costs nothing today and is the only thing standing between that column going null and a silent lie.
// cm:edge ordering -> packages/core/src/jobs/dispatcher.ts — must run AFTER `selectRunnerForJob` and BEFORE `ensureAgentSessionForJob`: earlier and the stale-pin fall-through has not happened yet, later and the session row is already stamped with a resume that was never possible.
export function finalizeResumeForDevice(
  policy: ResumePolicy,
  selectedDeviceId: string | null,
): ResumePolicy {
  const reachable = policy.pinDeviceId !== null && selectedDeviceId === policy.pinDeviceId;
  const pinMissed = policy.priorClaudeSessionId !== null && !reachable;
  const dropReason: ResumeDropReason | null = pinMissed ? 'pin_stale' : policy.record.dropReason;
  if (dropReason) recordResumeDrop(dropReason);
  if (!pinMissed) return policy;
  return {
    ...policy,
    priorClaudeSessionId: null,
    record: { ...policy.record, resumed: false, dropReason },
  };
}
