import { and, eq, ne } from 'drizzle-orm';
import {
  insertSessionRow,
  masterSessionIfOwned,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { type AgentSessionStatus, agentSessions, issues, jobs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { deviceRoom, projectRoom, roomManager } from '../lib/rooms.js';
import type { FailureCause } from '../pipeline/index.js';
import { classifyFailure, closeRunIfOneShot } from '../pipeline/index.js';
import type { ResumeRecord } from './resume-policy.js';

type JobRow = typeof jobs.$inferSelect;

const TITLE_MAX = 200;

function deriveSkillName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).skillName;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function deriveStageStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).stageStatus;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildTitle(skillName: string | null, jobType: string, issueTitle: string | null): string {
  const head = skillName ?? jobType;
  const tail = issueTitle && issueTitle.length > 0 ? `: ${issueTitle}` : '';
  return `${head}${tail}`.slice(0, TITLE_MAX);
}

/**
 * The master session holding this job, where it holds one core can stand behind.
 *
 * `jobs.held_by` is core's own record, not the box's report, and is still
 * checked: a released hold, or one naming a session that is not a master of
 * this project, leaves the child a root rather than a wrong parent.
 */
async function resolveHoldingMaster(job: JobRow): Promise<string | null> {
  if (!job.heldBy) return null;
  const owned = await masterSessionIfOwned({
    sessionId: job.heldBy,
    projectId: job.projectId,
    deviceId: job.deviceId,
  });
  if (!owned) {
    logger.warn(
      { jobId: job.id, heldBy: job.heldBy, projectId: job.projectId },
      'agent-session-link: held_by does not name a master of this project, so the session opens as a root',
    );
  }
  return owned;
}

type ParentSession = { id: string; metadata: unknown; pipelineHealth: unknown };

/** The session of the job this one retries, whose health and root the retry inherits. */
async function loadRetryParentSession(job: JobRow): Promise<ParentSession | null> {
  if (!job.retryOf) return null;
  const [parentJob] = await db
    .select({ agentSessionId: jobs.agentSessionId })
    .from(jobs)
    .where(eq(jobs.id, job.retryOf))
    .limit(1);
  if (!parentJob?.agentSessionId) return null;
  const [row] = await db
    .select({
      id: agentSessions.id,
      metadata: agentSessions.metadata,
      pipelineHealth: agentSessions.pipelineHealth,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, parentJob.agentSessionId))
    .limit(1);
  return row ?? null;
}

async function loadIssueFacts(
  job: JobRow,
): Promise<{ title: string | null; ownerId: string | null; issSeq: number | null }> {
  if (!job.issueId) return { title: null, ownerId: null, issSeq: null };
  const [row] = await db
    .select({ title: issues.title, createdById: issues.createdById, issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, job.issueId))
    .limit(1);
  return {
    title: row?.title ?? null,
    ownerId: row?.createdById ?? null,
    issSeq: row?.issSeq ?? null,
  };
}

function sessionMetadata(
  job: JobRow,
  resume: ResumeRecord,
  skillName: string | null,
  issSeq: number | null,
  parentSession: ParentSession | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { jobId: job.id, jobType: job.type };
  if (job.issueId) metadata.issueId = job.issueId;
  // Stamp the human-readable issue sequence so the sidebar can render
  // "ISS-N" sub-text without an extra issue lookup. Frozen at session
  // creation time — issSeq is immutable per project anyway.
  if (issSeq !== null) metadata.issSeq = issSeq;
  if (skillName) metadata.skillName = skillName;
  if (job.deviceId) metadata.deviceId = job.deviceId;
  metadata.resume = resume;
  const payloadStageStatus = deriveStageStatus(job.payload);
  if (payloadStageStatus) metadata.stageStatus = payloadStageStatus;
  if (job.retryOf) {
    metadata.attempt = job.attempts;
    metadata.retryOfJobId = job.retryOf;
    if (parentSession) {
      metadata.retryOfSessionId = parentSession.id;
      const parentMetadata = (parentSession.metadata ?? {}) as Record<string, unknown>;
      metadata.rootSessionId =
        typeof parentMetadata.rootSessionId === 'string'
          ? parentMetadata.rootSessionId
          : parentSession.id;
    }
  }
  return metadata;
}

export async function ensureAgentSessionForJob(
  job: JobRow,
  context: { repoPath: string | null; resume: ResumeRecord },
): Promise<string | null> {
  try {
    if (job.agentSessionId) return job.agentSessionId;
    const parentSession = await loadRetryParentSession(job);
    const issue = await loadIssueFacts(job);
    const skillName = deriveSkillName(job.payload);
    const title = buildTitle(skillName, job.type, issue.title);
    const metadata = sessionMetadata(job, context.resume, skillName, issue.issSeq, parentSession);

    // Pipeline sessions enter `queued`; worker CAS flips to `running` on
    // first write (routes.ts PATCH/send). Separates "waiting for worker"
    // from "actually streaming" so the sweeper can distinguish zombies.
    // ISS-101 — inherit the parent job's pipeline_run so the session shares its job's run lifecycle.
    const parentSessionId = await resolveHoldingMaster(job);
    const inserted = await insertSessionRow(db, {
      projectId: job.projectId,
      userId: issue.ownerId,
      deviceId: job.deviceId,
      pipelineRunId: job.pipelineRunId,
      title,
      kind: 'pipeline',
      parentSessionId,
      status: 'queued',
      dispatchedAt: new Date(),
      repoPath: context.repoPath,
      metadata: metadata as never,
      ...(parentSession?.pipelineHealth
        ? { pipelineHealth: parentSession.pipelineHealth as never }
        : {}),
    });

    await db.update(jobs).set({ agentSessionId: inserted.id }).where(eq(jobs.id, job.id));

    broadcastSessionEvent(inserted.id, job.projectId, job.deviceId, 'agent-session.created', {
      title,
      issueId: job.issueId,
    });

    return inserted.id;
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'agent-session-link: failed to link session');
    return null;
  }
}

/**
 * Errors a SWEEPER wrote, not the agent: each one names the consequence of a
 * death some other row already diagnosed. They are the only job errors that
 * must not overwrite a session's own reason.
 */
export const SYNTHETIC_REAP_ERRORS = new Set([
  'session_lost',
  'dispatch_unclaimed',
  'stale',
  'park_unanswered',
]);

/**
 * ISS-877 — the cause this session died of, asked of the SAME classifier the
 * job lane already asked.
 *
 * This function replaces the literal `'job_failed'`. That literal was the whole
 * defect: the `jobs` row beside it already carried `failure_kind`,
 * `failure_reason`, `failure_meta` and `classifier_version`, so the diagnosis
 * existed and was thrown away one column over. All eight sessions ISS-871 gave
 * up on were readable this way — seven `provider_spend_cap`, one
 * `provider_refused_request` — without opening a transcript.
 *
 * Both columns are JOINED and classified as one text, deliberately rather than
 * preferring either: a sweeper writes a precise phrase into `failureReason`
 * (`session_lost`, `dispatch_unclaimed`) that the error text lacks, while the
 * runner writes its marker (`[NO_RESULT_CLEAN_EXIT]`, `[SIGNAL_KILLED]`) into
 * `error` and leaves the other holding a sentence. When both name a cause,
 * `CAUSE_RULES` order decides, most-specific-first — not the column.
 */
function deriveSessionFailure(job: JobRow): {
  failureReason: FailureCause;
  failureDetail: string | null;
} {
  const text = [job.failureReason, job.error].filter(Boolean).join(' — ');
  const classified = classifyFailure({
    error: text,
    meta: (job.failureMeta ?? null) as Record<string, unknown> | null,
  });
  return {
    failureReason: classified.cause,
    failureDetail: classified.reason || text || null,
  };
}

// cm:why a job's terminal status is its session's: a cancelled job whose session read `completed`
// told every reader counting finished sessions that work was done which never ran (ISS-100).
const SESSION_STATUS_OF_JOB_OUTCOME = {
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<'done' | 'failed' | 'cancelled', AgentSessionStatus>;

/**
 * Mirror a job lifecycle transition (done / failed / cancelled) onto its
 * linked `agent_sessions` row. Best-effort — swallows errors so a failure to
 * write observability metadata never breaks the lifecycle response.
 */
export async function syncAgentSessionLifecycle(
  job: JobRow,
  outcome: 'done' | 'failed' | 'cancelled',
  options?: { retryPending?: boolean },
): Promise<void> {
  if (!job.agentSessionId) {
    // ISS-101 — even without a linked session, close one-shot runs whose
    // backing job terminated without spawning a session.
    if (!options?.retryPending) {
      try {
        const runOutcome =
          outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed';
        await closeRunIfOneShot(job.pipelineRunId, runOutcome);
      } catch (err) {
        logger.warn({ err, jobId: job.id }, 'agent-session-link: close-run (no-session) failed');
      }
    }
    return;
  }
  try {
    const status = SESSION_STATUS_OF_JOB_OUTCOME[outcome];
    await transitionSessions(db, {
      to: status,
      set:
        status === 'failed'
          ? { ...deriveSessionFailure(job), updatedAt: new Date() }
          : { failureReason: null, failureDetail: null, updatedAt: new Date() },
      where:
        status === 'failed' && SYNTHETIC_REAP_ERRORS.has(job.error ?? '')
          ? and(eq(agentSessions.id, job.agentSessionId), ne(agentSessions.status, 'failed'))
          : eq(agentSessions.id, job.agentSessionId),
      reason: `job_${outcome}`,
      actor: { type: 'system' },
      source: 'lifecycle-sync',
    });
    broadcastSessionStatus(job.agentSessionId, job.projectId, job.deviceId, status);

    if (!options?.retryPending) {
      const runOutcome =
        outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed';
      await closeRunIfOneShot(job.pipelineRunId, runOutcome);
    }
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, agentSessionId: job.agentSessionId },
      'agent-session-link: lifecycle sync failed',
    );
  }
}

export function broadcastSessionEvent(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  event: string,
  extra: Record<string, unknown>,
): void {
  const payload = {
    event,
    data: { sessionId, projectId, deviceId, ...extra },
  };
  roomManager.publish(projectRoom(projectId), payload);
  if (deviceId) roomManager.publish(deviceRoom(deviceId), payload);
}

function broadcastSessionStatus(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  status: string,
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', { status });
}
