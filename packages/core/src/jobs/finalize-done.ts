import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, eq, gte } from 'drizzle-orm';
import { deriveSessionFinal } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { issueStepContexts, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import { projectRoom, roomManager } from '../lib/rooms.js';
import { transition } from '../lifecycle/index.js';
import { logger } from '../observability/logger.js';
import { materializeJobUsage } from '../usage-records/index.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';

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
  const [updated] = (
    await transition(db, JOB_MACHINE, {
      to: 'done',
      set: { exitCode: 0, error: null, finishedAt: new Date() },
      where: and(eq(jobs.id, job.id), eq(jobs.status, job.status)),
      reason,
      actor: { type: 'system' },
      source: 'finalize-done',
    })
  ).rows;
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

  if (updated.issueId) await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  return true;
}
