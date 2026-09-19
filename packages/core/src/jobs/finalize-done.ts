import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStepContexts, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { deriveSessionFinal } from './session-transcript.js';

type JobRow = typeof jobs.$inferSelect;

export async function hasTerminalHandoffForAttempt(job: JobRow): Promise<boolean> {
  if (!job.pipelineRunId) return false;
  const since = job.dispatchedAt ?? job.queuedAt ?? null;
  const conditions = [
    eq(issueStepContexts.pipelineRunId, job.pipelineRunId),
    eq(issueStepContexts.kind, 'handoff'),
    eq(issueStepContexts.step, job.type),
  ];
  if (since) conditions.push(gte(issueStepContexts.updatedAt, since));
  const rows = await db
    .select({ id: issueStepContexts.id })
    .from(issueStepContexts)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

/**
 * CAS-flip a job to `done` and run the shared completion side-effects (mirror
 * of the `/complete` done branch in `lifecycle-routes.ts`). The CAS is keyed on
 * the status the caller observed, so a concurrent terminal write wins instead
 * of double-finalizing.
 */
export async function finalizeJobDone(job: JobRow, reason: string): Promise<boolean> {
  const [updated] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'done',
    set: { exitCode: 0, error: null, finishedAt: new Date() },
    where: and(eq(jobs.id, job.id), eq(jobs.status, job.status)),
    fromStatus: job.status,
    reason,
    actor: { type: 'system' },
    source: 'finalize-done',
  });
  if (!updated) return false; // lost the race; another writer owns the terminal state

  logger.warn(
    { jobId: updated.id, type: updated.type, priorStatus: job.status, reason },
    'finalize-done: job marked done from agent handoff signal (runner reported failure but the step completed)',
  );

  // Best-effort transcript derive (CLI runner never PATCHes the session row).
  if (updated.agentSessionId) void deriveSessionFinal(updated.id, updated.agentSessionId);
  // ISS-439 — materialize the usage_records row from the same stored job_events.
  void materializeJobUsage(updated);
  await syncAgentSessionLifecycle(updated, 'done');

  roomManager.publish(projectRoom(updated.projectId), {
    event: 'job.completed',
    data: { jobId: updated.id, status: 'done', exitCode: 0 },
  });
  await hooks.emit('jobCompleted', {
    jobId: updated.id,
    projectId: updated.projectId,
    issueId: updated.issueId,
    type: updated.type,
  });

  if (updated.issueId) await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  return true;
}
