// A project's cleanup window (REQ-79 BC-7, BC-19): its `cleanup` schedule, an ordinary schedule a
// person re-times like any other. A window exists only where a project turned one on (ISS-1049):
// reading or recording debt, rating a change high and a release going past the gate never create or
// enable one, so a project whose window a person disabled, or that never wanted one, keeps none on.

import type { CleanupWindowRun } from '@forge/contracts/cleanup';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { scheduleRuns, schedules } from '../db/schema.js';

export interface CleanupWindow {
  scheduleId: string;
  cron: string;
  timeZone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  /** Its newest fire, as the schedule's last status reads it (ISS-1058); null where it never fired. */
  lastRun: CleanupWindowRun | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * The window's newest fire, read from the fire's own record: running since when, or how it ended and
 * whether a cleanup report names it. A run that ended without one says so (`fires.ts:settleSessionFires`
 * records why), so the row never shows an older report as if it were this run's.
 */
async function lastRunOf(
  scheduleId: string,
  executor: Pick<Tx, 'select'>,
): Promise<CleanupWindowRun | null> {
  const [fire] = await executor
    .select({
      status: scheduleRuns.status,
      startedAt: scheduleRuns.startedAt,
      finishedAt: scheduleRuns.finishedAt,
      error: scheduleRuns.error,
      // the column named whole: a bare "id" here would read the report's own id
      reported: sql<boolean>`EXISTS (SELECT 1 FROM cleanup_reports c WHERE c.schedule_run_id = schedule_runs.id)`,
    })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
    .limit(1);
  if (!fire) return null;
  return {
    status: fire.status,
    startedAt: fire.startedAt.toISOString(),
    finishedAt: iso(fire.finishedAt),
    reported: Boolean(fire.reported),
    error: fire.error ?? null,
  };
}

const windowOf = (
  row: typeof schedules.$inferSelect,
  lastRun: CleanupWindowRun | null,
): CleanupWindow => ({
  scheduleId: row.id,
  cron: row.cron,
  timeZone: row.timeZone,
  enabled: row.enabled,
  nextRunAt: iso(row.nextRunAt),
  lastRun,
});

/** The project's first cleanup schedule with its newest fire, or null where it has none. */
export async function readCleanupWindow(
  projectId: string,
  executor: Pick<Tx, 'select'> = db,
): Promise<CleanupWindow | null> {
  const [row] = await executor
    .select()
    .from(schedules)
    .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, 'cleanup')))
    .orderBy(asc(schedules.createdAt))
    .limit(1);
  return row ? windowOf(row, await lastRunOf(row.id, executor)) : null;
}
