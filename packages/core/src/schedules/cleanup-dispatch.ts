// The `cleanup` schedule branch (REQ-79 BC-7, BC-8): the project's cleanup run, started in its
// window on a slot of its own. It starts a chat session on a box, as a prompt fire does: not a pool
// job, which `max_job_panes` caps, and not a run session a master declares, so it never takes a
// delivery run's slot. Its own slot is one: a fire while the last cleanup run is still live starts
// nothing. What it is briefed with, and whether there is anything to clean, are the cleanup module's
// (`cleanup/fire.ts`), reached through the schedules ports (ADR 0008).

import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns, schedules } from '../db/schema.js';
import type { Refusal } from '../lib/refusal.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { schedulesPorts } from './ports.js';

type StartSession = (
  input: DispatchScheduleInput,
  fireId: string,
  prompt: string | null,
) => Promise<RoutedFire>;

const refused = (refusal: Refusal): RoutedFire => ({
  result: { ok: false, reason: 'rule-refused', status: 'skipped', refusal },
  settle: { status: 'skipped', reason: 'gate-refused', refusal: refusal.code, output: refusal.detail },
});

/** Whether another fire of this project's cleanup schedules still holds a live run. */
async function cleanupRunLive(projectId: string, fireId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: scheduleRuns.id })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(
      and(
        eq(scheduleRuns.projectId, projectId),
        eq(schedules.kind, 'cleanup'),
        eq(scheduleRuns.status, 'running'),
        ne(scheduleRuns.id, fireId),
        sql`${scheduleRuns.sessionId} IS NOT NULL`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export async function routeScheduleCleanupFire(
  input: DispatchScheduleInput,
  fireId: string,
  startSession: StartSession,
): Promise<RoutedFire> {
  const { projectId } = input.schedule;
  const plan = await schedulesPorts().cleanupFire({ projectId, fireId });
  if (plan.kind === 'off') {
    return refused({ code: 'FAST_DELIVERY_OFF', path: '', detail: plan.why });
  }
  if (plan.kind === 'nothing') {
    return {
      result: { ok: true, sessionId: null, status: 'skipped', resolvedProjectId: projectId },
      settle: { status: 'skipped', reason: 'nothing-to-do', output: plan.why },
    };
  }
  const live = await cleanupRunLive(projectId, fireId);
  if (live) {
    return refused({
      code: 'CLEANUP_RUN_LIVE',
      path: '',
      detail: `the cleanup run fire ${live} started is still live, and a project's cleanup runs one at a time on its own slot (REQ-79 BC-8): this window starts nothing, and the next one finds whatever it leaves`,
    });
  }
  return startSession(input, fireId, plan.prompt);
}
