import type { ResumeDropReason } from '@forge/contracts/resume-drop';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { recordResumeDrop } from '../lib/hold-metrics.js';
import { logger } from '../lib/logger.js';
import { traceStep } from '../lib/sentry.js';
import { estimateIssueContextTokens, MAX_RESUME_TOKENS } from './session-resume.js';

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

interface ResumePolicy {
  priorClaudeSessionId: string | null;
  pinDeviceId: string | null;
  isRetry: boolean;
  record: ResumeRecord;
}

/**
 * The parent attempt a retry could continue: its CLI session, the box holding that session's
 * file, and the action the classifier gave the failure. Reached through the retry chain, which
 * is the only relation that survives — a retry's parent is `failed` by definition.
 */
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

/** ISS-580 — drop the resume when the issue's accumulated context has outgrown the
 *  project's bound. Returns the drop reason, or null when the bound holds. */
async function exceedsResumeBounds(args: {
  job: typeof jobs.$inferSelect;
  issueId: string;
}): Promise<ResumeDropReason | null> {
  const estTokens = await estimateIssueContextTokens(args.issueId);
  if (estTokens <= MAX_RESUME_TOKENS) return null;
  const reason: ResumeDropReason = 'resume_bound_tokens';
  logger.info(
    {
      jobId: args.job.id,
      issueId: args.issueId,
      estTokens,
      maxResumeTokens: MAX_RESUME_TOKENS,
      reason,
    },
    'resume-policy: resume bound exceeded — dispatching fresh session',
  );
  traceStep({
    category: 'pipeline.resume_bound',
    data: { reason, estTokens },
  });
  return reason;
}

export async function resolveResumePolicy(args: {
  job: typeof jobs.$inferSelect;
}): Promise<ResumePolicy> {
  const { job } = args;
  let offeredClaudeSessionId: string | null = null;
  let offeredDeviceId: string | null = null;
  let parentFailureAction: string | null = null;
  let dropReason: ResumeDropReason | null = null;
  let pinDeviceId: string | null = null;

  const isRetry = job.retryOf != null;
  // A retry may continue its parent's CLI session only on the box holding that session's file and
  // only after a plain `retry` failure. Nothing routes the retry there: whichever box claims it
  // decides, and finalizeResumeForDevice records `pin_stale` when it is another one.
  if (isRetry) {
    const parent = await loadParentAttempt(job);
    offeredClaudeSessionId = parent?.claudeSessionId ?? null;
    offeredDeviceId = parent?.deviceId ?? null;
    parentFailureAction = parent?.failureAction ?? null;
    pinDeviceId = offeredDeviceId;
    if (parent && parent.failureAction !== 'retry') dropReason = 'failure_action';
    if (!dropReason && offeredClaudeSessionId && job.issueId) {
      dropReason = await exceedsResumeBounds({ job, issueId: job.issueId });
      if (dropReason) pinDeviceId = null;
    }
  }

  const priorClaudeSessionId = dropReason === null ? offeredClaudeSessionId : null;

  return {
    priorClaudeSessionId,
    pinDeviceId,
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
 * `resolveResumePolicy` runs BEFORE the claim, so it can only propose a pin. Step 1 of
 * `pickRunner` returns null when the pinned runner is offline, stale or incapable and falls
 * through to primary/standby — the job lands on a box that does not hold the prior session's CLI
 * file. Until this ran, nothing re-read the session id afterwards: it reached the runner payload
 * anyway and the attempt's row recorded `resumed: true`, so the one path that could still be
 * caught at dispatch time was the one that claimed a continuation instead of reporting a loss.
 */
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
