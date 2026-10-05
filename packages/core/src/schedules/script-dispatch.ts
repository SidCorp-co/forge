import { logger } from '../lib/logger.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { schedulesPorts } from './ports.js';
import { resolveScheduleTargetProject } from './release-batch-dispatch.js';
import { runScheduleScript } from './script/executor.js';

export async function routeScheduleScriptFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { schedule } = input;

  if (!schedule.script) {
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed' },
      settle: { status: 'failed', error: 'this script-kind schedule has no script' },
    };
  }

  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) {
    return {
      result: { ok: false, reason: 'project-not-found', status: 'skipped' },
      settle: { status: 'skipped', reason: 'project-not-found' },
    };
  }
  const { projectId: resolvedProjectId, userId } = resolved;

  const outcome = await runScheduleScript({
    script: schedule.script,
    params: schedule.params ?? null,
  });

  for (const n of outcome.notifications) {
    try {
      await schedulesPorts().emitNotification({
        userId,
        projectId: resolvedProjectId,
        type: 'schedule_report',
        title: n.title,
        body: n.body ?? null,
        scheduleRunId: fireId,
      });
    } catch (err) {
      logger.error(
        { err, scheduleId: schedule.id, fireId },
        'schedule.dispatch: schedule_report notification delivery failed',
      );
    }
  }

  if (outcome.status === 'failed') {
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed' },
      settle: { status: 'failed', error: outcome.error, output: outcome.output },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: 'success', resolvedProjectId },
    settle: { status: 'success', output: outcome.output },
  };
}
