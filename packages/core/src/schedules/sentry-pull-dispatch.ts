import { runSentryPull, type SentryPullOutcome } from '../error-intake/index.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { resolveScheduleTargetProject } from './release-batch-dispatch.js';

export async function routeScheduleSentryPullFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) {
    return {
      result: { ok: false, reason: 'project-not-found', status: 'skipped' },
      settle: { status: 'skipped', reason: 'project-not-found' },
    };
  }
  const { projectId } = resolved;

  const outcome: SentryPullOutcome = await runSentryPull({
    projectId,
    scheduleRunId: fireId,
  }).catch((err: unknown) => ({
    status: 'failed' as const,
    output: '',
    error: `sentry pull: ${err instanceof Error ? err.message : 'unknown error'}`,
  }));

  if (outcome.status === 'failed') {
    const error = outcome.error ?? outcome.output;
    return {
      result: { ok: false, reason: 'run-failed', status: 'failed', error },
      settle: { status: 'failed', error, output: outcome.output },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: outcome.status, resolvedProjectId: projectId },
    settle:
      outcome.status === 'skipped'
        ? { status: 'skipped', reason: 'nothing-to-do', output: outcome.output }
        : { status: 'success', output: outcome.output },
  };
}
