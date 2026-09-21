import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns } from '../db/schema.js';
import { runSentryPull, type SentryPullOutcome } from '../integrations/sentry/intake.js';
import { logger } from '../logger.js';
import type { DispatchScheduleInput, DispatchScheduleResult } from './dispatch-types.js';
import { resolveScheduleTargetProject } from './release-batch-dispatch.js';

export async function dispatchScheduleSentryPull(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const { schedule } = input;
  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) return { ok: false, reason: 'project-not-found', status: 'skipped' };
  const { projectId } = resolved;

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

  const outcome: SentryPullOutcome = await runSentryPull({ projectId }).catch((err: unknown) => ({
    status: 'failed' as const,
    output: '',
    error: `sentry pull: ${err instanceof Error ? err.message : 'unknown error'}`,
  }));

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
  return { ok: true, status: 'success', sessionId: run.id, resolvedProjectId: projectId };
}
