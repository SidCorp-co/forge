/**
 * Handoff-as-completion override (false-failure fix).
 *
 * Root cause: the runner classifies a job `failed` whenever it cannot capture
 * the Claude CLI terminal `result` event — `succeeded_opt.unwrap_or(false)` in
 * `packages/runner/.../runner/claude_code.rs` defaults a *missing* result line
 * (EOF/child-exit race, MCP grandchildren holding the pipe, late buffering) to
 * failure, surfacing as `"Agent completed with errors"` (exit_code NULL) even
 * though the agent ran the step to completion. On forge-dev this was the
 * dominant failure mode (≈253 null-exit "Agent completed with errors" / 10d),
 * and it ALSO masks the silent-runner-death class when the agent finished its
 * work first.
 *
 * Fix: the agent's own `forge_step_handoff.write` is a far more reliable
 * "I ran the step to completion" signal — it is a near-terminal action written
 * AFTER the substantive work. So at the single failure-finalize chokepoint
 * (`finalizeFailedJob`), if a terminal handoff exists for this attempt, trust
 * it over the runner's exit detection and mark the job `done`.
 *
 * Note: this is the JOB lifecycle axis only. The issue STATUS is still
 * agent-driven (prompt-layer) — we do not auto-advance status here. So this
 * does not reverse the deliberate "handoff is not a status gate" decision; it
 * only stops a completed step from being recorded as a failure.
 */

import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStepContexts, jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import { deriveSessionFinal } from './session-transcript.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * True when the agent wrote a terminal step-handoff for THIS job's step during
 * (or after) this attempt's dispatch window.
 *
 * Scoped by `pipeline_run_id + step` plus an `updated_at >= dispatched_at`
 * time window rather than by attempt number, because agents hard-code
 * `attempt: 1` in the termination-protocol template — a retry upserts the same
 * (issueId, step, attempt) handoff row, so only `updated_at` distinguishes a
 * fresh write for this attempt from a stale prior one.
 */
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
  const [updated] = await db
    .update(jobs)
    .set({ status: 'done', exitCode: 0, error: null, finishedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, job.status)))
    .returning();
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

  void dispatchTickForProject(updated.projectId);
  if (updated.issueId) await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
  return true;
}
