// The `status_report` schedule branch: store the project status read for the period this fire
// answers and tell each recipient once. Like `release_batch` it needs no device and no session; the
// store and the notices belong to `status-reports`, reached through the schedules ports (ADR 0008).

import { isRefusal, type Refusal } from '../lib/refusal.js';
import { slotAt } from './cron.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { type StatusReportSendOutcome, schedulesPorts } from './ports.js';
import { statusReportParamsOf } from './status-report-params.js';

const refusedFire = (refusal: Refusal, status: 'failed' | 'skipped'): RoutedFire => ({
  result: { ok: false, reason: 'rule-refused', status, refusal },
  settle:
    status === 'skipped'
      ? { status, reason: 'gate-refused', refusal: refusal.code, output: refusal.detail }
      : { status, error: `${refusal.code}: ${refusal.detail}` },
});

export async function routeScheduleStatusReportFire(
  input: DispatchScheduleInput,
  fireId: string,
  now: Date = new Date(),
): Promise<RoutedFire> {
  const { schedule } = input;
  if (!schedule.cron) {
    throw new Error(
      `schedule ${schedule.id}: a status_report fire reached dispatch without its cron`,
    );
  }
  const viewerUserId = input.actor?.userId ?? schedule.ownerId;
  if (!viewerUserId) {
    return refusedFire(
      {
        code: 'SCHEDULE_REFUSED',
        path: '/ownerId',
        detail:
          'this schedule has no owner to read the status as: the account that saved it is gone, so an admin saves it again',
      },
      'failed',
    );
  }
  let params: Awaited<ReturnType<typeof statusReportParamsOf>>;
  try {
    params = await statusReportParamsOf(schedule.projectId, schedule.params);
  } catch (err) {
    if (isRefusal(err)) return refusedFire(err.refusals[0] as Refusal, 'failed');
    throw err;
  }
  let outcome: StatusReportSendOutcome;
  try {
    outcome = await schedulesPorts().sendStatusReport({
      projectId: schedule.projectId,
      scheduleId: schedule.id,
      viewerUserId,
      recipients: params.recipients,
      days: params.days,
      period: slotAt(schedule.cron, now, schedule.timeZone ?? null),
      timeZone: schedule.timeZone ?? null,
      fireId,
    });
  } catch (err) {
    if (isRefusal(err)) return refusedFire(err.refusals[0] as Refusal, 'failed');
    throw err;
  }
  if (outcome.status === 'refused') {
    return refusedFire({ code: outcome.code, path: '', detail: outcome.detail }, 'skipped');
  }
  return {
    result: {
      ok: true,
      sessionId: null,
      status: 'success',
      resolvedProjectId: schedule.projectId,
    },
    settle: { status: 'success', output: outcome.output },
  };
}
