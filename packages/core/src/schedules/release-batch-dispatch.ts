// The `release_batch` schedule branch: cut whatever is waiting at the gate.
//
// Lives beside `dispatch.ts` rather than inside it because that file is at its
// size budget and this branch shares nothing with the agent-session path — no
// device, no session, no Claude runner.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, scheduleRuns } from '../db/schema.js';
import { logger } from '../logger.js';
import type { DispatchScheduleInput, DispatchScheduleResult } from './dispatch-types.js';
import { runScheduledReleaseCut } from './release-batch-run.js';

/**
 * Which project a schedule acts on, and whose authority it acts with. Shared by
 * the two runner-less kinds so they cannot disagree about a `targetProjectSlug`.
 */
export async function resolveScheduleTargetProject(
  input: DispatchScheduleInput,
): Promise<{ projectId: string; userId: string } | null> {
  const { schedule } = input;
  let projectId = schedule.projectId;
  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, createdBy: projects.createdBy })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return null;
    projectId = target.id;
  }
  const userId =
    input.actorUserId ?? (await loadCreatedBy(projectId, input.resolvedTarget?.createdBy));
  if (!userId) return null;
  return { projectId, userId };
}

/**
 * A `release_batch` schedule: claim everything waiting at the gate and enqueue
 * the batch job. Same shape as the script branch — a `schedule_runs` row, no
 * agent session, no Claude runner — because the work is one REST-equivalent
 * call, not a conversation.
 */
export async function dispatchScheduleReleaseBatchRun(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const { schedule } = input;
  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) return { ok: false, reason: 'project-not-found', status: 'skipped' };
  const { projectId, userId } = resolved;

  const [run] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId: schedule.id,
      projectId,
      trigger: input.tick ? 'scheduled' : 'manual',
      status: 'running',
      startedAt: new Date(),
    })
    .returning({ id: scheduleRuns.id });
  if (!run) {
    logger.error({ scheduleId: schedule.id }, 'schedule.dispatch: schedule_runs insert failed');
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  const outcome = await runScheduledReleaseCut({ projectId, userId });

  try {
    await db
      .update(scheduleRuns)
      .set({
        status: outcome.status,
        output: outcome.output,
        error: outcome.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(scheduleRuns.id, run.id));
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, runId: run.id },
      'schedule.dispatch: schedule_runs update failed',
    );
  }

  if (outcome.status === 'failed') {
    return { ok: false, reason: 'session-failed', status: 'failed', sessionId: run.id };
  }
  // cm:why a skipped cut reports `success` on the RESULT type (which has no 'skipped' + ok:true arm) while `schedule_runs.status` keeps the honest 'skipped' — a quiet night is not a dispatch failure, and the run row is where a person looks for what happened
  return { ok: true, status: 'success', sessionId: run.id, resolvedProjectId: projectId };
}

/** The user a runner-less schedule acts as: the caller, else the project owner. */
export async function loadCreatedBy(projectId: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy;
}
