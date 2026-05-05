import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

type JobRow = typeof jobs.$inferSelect;

const TITLE_MAX = 200;

function deriveSkillName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).skillName;
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
 * 2. If the job is a retry (`retryOf` set) and the parent has an
 *    `agentSessionId`, reuse it: link this job to the same session and flip
 *    the session back to `running`. The session row therefore tracks the
 *    full retry chain, not each attempt.
 * 3. Otherwise, INSERT a new `agent_sessions` row and link it.
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

    if (job.retryOf) {
      const [parent] = await db
        .select({ agentSessionId: jobs.agentSessionId })
        .from(jobs)
        .where(eq(jobs.id, job.retryOf))
        .limit(1);
      if (parent?.agentSessionId) {
        // ISS-34: re-queue the parent session for the retry. The worker will
        // CAS it back to `running` when it claims (see routes.ts patch path).
        const now = new Date();
        await db
          .update(agentSessions)
          .set({
            status: 'queued',
            dispatchedAt: now,
            startedAt: null,
            lastHeartbeatAt: null,
            failureReason: null,
            updatedAt: now,
          })
          .where(eq(agentSessions.id, parent.agentSessionId));
        await db
          .update(jobs)
          .set({ agentSessionId: parent.agentSessionId })
          .where(eq(jobs.id, job.id));
        broadcastSessionStatus(parent.agentSessionId, job.projectId, job.deviceId, 'queued');
        return parent.agentSessionId;
      }
    }

    let issueTitle: string | null = null;
    let issueOwnerId: string | null = null;
    if (job.issueId) {
      const [row] = await db
        .select({ title: issues.title, createdById: issues.createdById })
        .from(issues)
        .where(eq(issues.id, job.issueId))
        .limit(1);
      issueTitle = row?.title ?? null;
      issueOwnerId = row?.createdById ?? null;
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
    if (skillName) metadata.skillName = skillName;
    if (job.deviceId) metadata.deviceId = job.deviceId;

    // ISS-34: pipeline sessions start `queued`. Worker flips to `running`
    // (CAS) when it actually claims the job — see routes.ts PATCH /:id and
    // /send hooks. This separates "enqueued, waiting for worker" from
    // "worker is actually streaming" so the sweeper can fail zombies.
    const [inserted] = await db
      .insert(agentSessions)
      .values({
        projectId: job.projectId,
        userId: issueOwnerId,
        deviceId: job.deviceId,
        title,
        status: 'queued',
        dispatchedAt: new Date(),
        repoPath: context.repoPath,
        metadata: metadata as never,
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
): Promise<void> {
  if (!job.agentSessionId) return;
  try {
    // agent_sessions enum has no 'cancelled' — map to 'completed' so the row
    // leaves the running state. The job row keeps the precise terminal status.
    const status: 'completed' | 'failed' =
      outcome === 'done' || outcome === 'cancelled' ? 'completed' : 'failed';
    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'failed') updates.failureReason = 'job_failed';
    await db
      .update(agentSessions)
      .set(updates)
      .where(eq(agentSessions.id, job.agentSessionId));
    broadcastSessionStatus(job.agentSessionId, job.projectId, job.deviceId, status);
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, agentSessionId: job.agentSessionId },
      'agent-session-link: lifecycle sync failed',
    );
  }
}

function broadcastSessionEvent(
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
