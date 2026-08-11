import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

type JobRow = typeof jobs.$inferSelect;

const TITLE_MAX = 200;

function deriveSkillName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).skillName;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function deriveSessionGroup(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).sessionGroup;
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
 * Ensure a pipeline-driven job has a backing `agent_sessions` row so it shows
 * up in `/pipeline` and the issue detail "Agent Sessions" tab.
 *
 * Idempotency rules:
 * 1. If `job.agentSessionId` is already set, no-op.
 * 2. Otherwise, INSERT a new `agent_sessions` row and link it — ALWAYS,
 *    including for a retry (`job.retryOf` set). Every attempt gets its own
 *    row so a still-writing prior attempt's `messages`/`startedAt` can never
 *    be overwritten by the retry that superseded it (ISS-785 — the old
 *    reuse+reset-in-place branch raced exactly that when the prior attempt
 *    wasn't actually dead yet, e.g. ISS-37). Retry continuity is metadata-only
 *    (`attempt` / `retryOfJobId` / `retryOfSessionId` / `rootSessionId`) plus
 *    a `pipelineHealth` snapshot carried forward from the parent row, so the
 *    UI can still group a chain without any row being mutated after the fact.
 *
 * Returns the resolved session id, or `null` if the operation failed
 * non-fatally (the caller continues — observability is best-effort, never
 * blocks dispatch).
 */
export async function ensureAgentSessionForJob(
  job: JobRow,
  context: { repoPath: string | null },
): Promise<string | null> {
  try {
    if (job.agentSessionId) return job.agentSessionId;

    let parentSession: {
      id: string;
      metadata: unknown;
      pipelineHealth: unknown;
    } | null = null;
    if (job.retryOf) {
      const [parentJob] = await db
        .select({ agentSessionId: jobs.agentSessionId })
        .from(jobs)
        .where(eq(jobs.id, job.retryOf))
        .limit(1);
      if (parentJob?.agentSessionId) {
        const [row] = await db
          .select({
            id: agentSessions.id,
            metadata: agentSessions.metadata,
            pipelineHealth: agentSessions.pipelineHealth,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, parentJob.agentSessionId))
          .limit(1);
        parentSession = row ?? null;
      }
    }

    let issueTitle: string | null = null;
    let issueOwnerId: string | null = null;
    let issueIssSeq: number | null = null;
    if (job.issueId) {
      const [row] = await db
        .select({
          title: issues.title,
          createdById: issues.createdById,
          issSeq: issues.issSeq,
        })
        .from(issues)
        .where(eq(issues.id, job.issueId))
        .limit(1);
      issueTitle = row?.title ?? null;
      issueOwnerId = row?.createdById ?? null;
      issueIssSeq = row?.issSeq ?? null;
    }

    const skillName = deriveSkillName(job.payload);
    const title = buildTitle(skillName, job.type, issueTitle);

    const metadata: Record<string, unknown> = {
      // PM jobs surface under the `pm` metadata.type filter
      // (see agent-sessions/routes.ts metadataType filter); pipeline jobs
      // keep the historical `pipeline` value.
      type: job.type === 'pm' ? 'pm' : 'pipeline',
      jobId: job.id,
      jobType: job.type,
    };
    if (job.issueId) metadata.issueId = job.issueId;
    // Stamp the human-readable issue sequence so the sidebar can render
    // "ISS-N" sub-text without an extra issue lookup. Frozen at session
    // creation time — issSeq is immutable per project anyway.
    if (issueIssSeq !== null) metadata.issSeq = issueIssSeq;
    if (skillName) metadata.skillName = skillName;
    if (job.deviceId) metadata.deviceId = job.deviceId;
    // PR-5 — session-group membership. The orchestrator stamped this on
    // job.payload.sessionGroup at enqueue time (resolved from
    // pipelineConfig.states[stage].sessionGroup); we propagate it here so
    // `findPriorSessionInGroup` can index by (issueId, sessionGroup).
    const payloadSessionGroup = deriveSessionGroup(job.payload);
    if (payloadSessionGroup) metadata.sessionGroup = payloadSessionGroup;
    // PR-5 — stamp the stage status so resume lookup can prefer prior
    // sessions whose stage is in the same group (without re-parsing job.type).
    const payloadStageStatus = deriveStageStatus(job.payload);
    if (payloadStageStatus) metadata.stageStatus = payloadStageStatus;

    // cm:why rootSessionId inherits from the parent's OWN metadata (not just parentSession.id) so the whole retry chain resolves to one root regardless of attempt count
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

    // Pipeline sessions enter `queued`; worker CAS flips to `running` on
    // first write (routes.ts PATCH/send). Separates "waiting for worker"
    // from "actually streaming" so the sweeper can distinguish zombies.
    // ISS-101 — inherit the parent job's pipeline_run so issue-driven and
    // PM sessions share the same run lifecycle as their job.
    const [inserted] = await db
      .insert(agentSessions)
      .values({
        projectId: job.projectId,
        userId: issueOwnerId,
        deviceId: job.deviceId,
        pipelineRunId: job.pipelineRunId,
        title,
        status: 'queued',
        dispatchedAt: new Date(),
        repoPath: context.repoPath,
        metadata: metadata as never,
        // cm:why carry pipelineHealth (recoveryStats/autoRetries) forward so it accumulates across a retry chain instead of resetting per row
        ...(parentSession?.pipelineHealth
          ? { pipelineHealth: parentSession.pipelineHealth as never }
          : {}),
      })
      .returning({ id: agentSessions.id });

    if (!inserted) {
      logger.warn({ jobId: job.id }, 'agent-session-link: insert returned no row');
      return null;
    }

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
    // backing job terminated (e.g. PM jobs that never spawned a session).
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
    // agent_sessions enum has no 'cancelled' — map to 'completed' so the row
    // leaves the running state. The job row keeps the precise terminal status.
    const status: 'completed' | 'failed' =
      outcome === 'done' || outcome === 'cancelled' ? 'completed' : 'failed';
    await applyKernelTransition(db, {
      entity: 'session',
      to: status,
      // cm:guard the completed branch MUST clear failureReason — the I1 trigger (migrations 0113/0118) stamps `orphan_under_terminal_run` on an ACTIVE session when its run goes terminal, and a late runner report then lands here and flips the row to `completed`; leaving the reason behind produces a completed-and-failed row (ISS-759, VISION No.10). Same contract as runs-cascade.ts's completedSuccess branch.
      set:
        status === 'failed'
          ? { failureReason: 'job_failed', updatedAt: new Date() }
          : { failureReason: null, updatedAt: new Date() },
      where: eq(agentSessions.id, job.agentSessionId),
      reason: `job_${outcome}`,
      actor: { type: 'system' },
      source: 'lifecycle-sync',
    });
    broadcastSessionStatus(job.agentSessionId, job.projectId, job.deviceId, status);

    // ISS-101 — close one-shot (pm/interactive) runs when their backing
    // job terminates. Issue-kind runs are not touched here; the issue
    // state-machine owns issue-run lifecycle. When a retry is scheduled
    // (failed outcome + retry row created) we leave the run open so the
    // retry job can be dispatched — the run-status filter in the picker
    // would otherwise skip it. The caller signals this via `retryPending`.
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
