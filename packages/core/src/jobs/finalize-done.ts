import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { and, asc, eq, gte } from 'drizzle-orm';
import { deriveSessionFinal, materializeJobUsage } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { issueStepContexts, jobEvents, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import { clearRunnerLimit, clearRunnerQuarantine } from '../runners/index.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { pushJobChanged } from './job-push.js';

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
 * ISS-283 — final authoritative derive of the agent_sessions transcript from
 * the streamed job_events (a CLI runner never PATCHes the session row), and
 * ISS-439 — the usage_records row, from the job events read here and handed to
 * agent-sessions. Fire-and-forget so neither can block or hang the finish.
 */
export function settleTranscriptAndUsage(row: JobRow): void {
  if (!row.agentSessionId) return;
  void deriveSessionFinal(row.id, row.agentSessionId);
  void db
    .select({ kind: jobEvents.kind, data: jobEvents.data, ts: jobEvents.ts })
    .from(jobEvents)
    .where(eq(jobEvents.jobId, row.id))
    .orderBy(asc(jobEvents.seq))
    .then((events) => materializeJobUsage(row, events))
    .catch((err) => logger.warn({ err, jobId: row.id }, 'usage: job events read failed'));
}

/** A job that ended done or cancelled: session mirror, broadcast, runner health, issue health. */
export async function publishFinished(
  row: JobRow,
  status: 'done' | 'cancelled',
  exitCode: number | null,
  opts: { clearRunnerHealth: boolean } = { clearRunnerHealth: status === 'done' },
): Promise<void> {
  await syncAgentSessionLifecycle(row, status);
  await pushJobChanged({
    projectId: row.projectId,
    jobId: row.id,
    deviceId: row.deviceId,
    event: status === 'done' ? 'job.completed' : 'job.cancelled',
    data: { jobId: row.id, status, exitCode },
    rooms: ['project'],
  });
  if (opts.clearRunnerHealth) {
    void clearRunnerLimit(row.runnerId, row.projectId);
    void clearRunnerQuarantine(row.runnerId, row.projectId);
  }
  // ISS-164 — activeSession clears, queued siblings may now classify differently.
  if (row.issueId) await publishPipelineHealthChanged(row.projectId, [row.issueId]);
}

/**
 * CAS-flip a job to `done` and run the shared completion side-effects. The CAS is keyed on
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

  settleTranscriptAndUsage(updated);
  // the runner reported a failure, so its limit or quarantine stamp stands
  await publishFinished(updated, 'done', 0, { clearRunnerHealth: false });
  return true;
}
