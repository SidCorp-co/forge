// The `sentry_pull` schedule branch: ask Sentry what is broken, and file what passes the gate.
//
// Lives beside `release-batch-dispatch.ts` and shares its shape for the same reason that file gives:
// `dispatch.ts` is at its size budget and this branch shares nothing with the agent-session path —
// no device, no session, no Claude runner. One `schedule_runs` row, written whichever way the pull
// went, because that row is the only place an operator can read what a tick did (ISS-1085 slice 3).

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns } from '../db/schema.js';
import { runSentryPull } from '../integrations/sentry/intake.js';
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

  const outcome = await runSentryPull({ projectId });

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
  // cm:why the same split `release_batch` makes: a pull that admitted nothing is a quiet night, not
  // a dispatch failure, so the RESULT says success while `schedule_runs.status` keeps the honest
  // `skipped` — and the run row is where a person looks for what happened.
  return { ok: true, status: 'success', sessionId: run.id, resolvedProjectId: projectId };
}
