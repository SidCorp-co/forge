// Resolves, for one dispatch, THREE coupled decisions that used to sit inline in
// `dispatchViaRunner`: whether to resume a prior Claude CLI session, which device to pin, and
// which devices to exclude. They are coupled because dropping a resume must also drop the pin
// that only existed to reach that session's file — three call sites got that pairing right
// inline, and a fourth would eventually not.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { recordResumeBoundFresh } from '../observability/hold-metrics.js';
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

export interface ResumePolicy {
  priorClaudeSessionId: string | null;
  pinDeviceId: string | null;
  excludeDeviceIds: string[];
  skipPrimary: boolean;
  isRetry: boolean;
}

/**
 * The parent attempt's Claude session, for a retry that is staying on the SAME box.
 *
 * `findPriorSessionInGroup` cannot answer this: it filters `status='completed'`, and a retry's
 * parent is `failed` by definition. So the id comes off the parent session row directly, reached
 * through the retry chain rather than through the session group.
 */
async function findParentAttemptSession(
  job: typeof jobs.$inferSelect,
): Promise<{ claudeSessionId: string; deviceId: string | null } | null> {
  if (!job.retryOf) return null;
  try {
    const [parentJob] = await db
      .select({ agentSessionId: jobs.agentSessionId })
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
    return { claudeSessionId: row.claudeSessionId, deviceId: row.deviceId };
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, retryOf: job.retryOf },
      'resume-policy: parent-attempt lookup failed, dispatching fresh',
    );
    return null;
  }
}

/** ISS-580 — drop the resume when the group's accumulated context or the issue's reopen count
 *  has outgrown its configured bound. Returns true when the resume must be dropped. */
async function exceedsResumeBounds(args: {
  job: typeof jobs.$inferSelect;
  issueId: string;
  sessionGroup: string;
  agentConfig: Record<string, unknown> | undefined;
}): Promise<boolean> {
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
  if (!overTokens && !overCycles) return false;
  const reason = overTokens ? ('tokens' as const) : ('reopen_cycles' as const);
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
  recordResumeBoundFresh(reason);
  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'pipeline.resume_bound',
      data: { reason, estTokens, reopenCount },
    });
  }
  return true;
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
  let priorClaudeSessionId: string | null = null;
  let pinDeviceId: string | null = null;

  // cm:guard a drive job must never inherit a staged step's CLI session: it resumes through `forge_phase` action `resume_point`, and --resume onto a stale triage session would hand the driver another step's transcript as its own history
  if (overrides.sessionGroup && job.issueId && job.type !== AUTONOMOUS_JOB_TYPE) {
    const prior = await findPriorSessionInGroup({
      issueId: job.issueId,
      sessionGroup: overrides.sessionGroup,
    });
    if (prior) {
      priorClaudeSessionId = prior.claudeSessionId;
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
    priorClaudeSessionId = null;
  }

  const isRetry = job.retryOf != null;

  // cm:why gated on `!isRetry` because the retry branch below decides its own resume — running the 3-query bound check here would spend three queries and emit a resume_bound_fresh metric plus a Sentry breadcrumb describing a resume that was never on the table
  if (
    !isRetry &&
    priorClaudeSessionId &&
    overrides.sessionGroup &&
    job.issueId &&
    (await exceedsResumeBounds({
      job,
      issueId: job.issueId,
      sessionGroup: overrides.sessionGroup,
      agentConfig: args.agentConfig,
    }))
  ) {
    priorClaudeSessionId = null;
    pinDeviceId = null;
  }

  const autoRetry = readAutoRetryPayload(job.payload);
  let excludeDeviceIds: string[];
  let skipPrimary: boolean;

  if (isRetry) {
    skipPrimary = true;
    excludeDeviceIds = autoRetry.done;
    pinDeviceId = autoRetry.target;
    // cm:why a rotation target computed before the pool was configured (or from a wider fleet) is dropped rather than honoured — selection then picks a standby INSIDE the pool instead of returning null and stalling the retry chain
    if (stagePool && pinDeviceId && !stagePool.includes(pinDeviceId)) pinDeviceId = null;
    // cm:guard a retry may resume ONLY when the rotation kept the same box AND the failure was classified `retry`. `nextRotation` rule 1 stays on one device for RETRY_TRIES_PER_DEVICE tries, and the CLI session file lives on that box — so this is the one case where the file is still reachable. A rotation to a different device must null the resume: the file is not there, and `--resume` onto a missing id costs a whole attempt. `failover`/`quarantine`/`terminal` never resume — failover exists to leave the box, and quarantine to condemn it.
    priorClaudeSessionId =
      pinDeviceId !== null && pinDeviceId === job.deviceId && job.failureAction === 'retry'
        ? ((await findParentAttemptSession(job))?.claudeSessionId ?? null)
        : null;
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
      priorClaudeSessionId = null;
    }
  }

  return { priorClaudeSessionId, pinDeviceId, excludeDeviceIds, skipPrimary, isRetry };
}
