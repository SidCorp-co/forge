// A project's cleanup window (REQ-79 BC-7, BC-19): its `cleanup` schedule, an ordinary schedule a
// person re-times like any other. A window exists only where a project turned one on (ISS-1049):
// reading or recording debt, rating a change high and a release going past the gate never create or
// enable one, so a project whose window a person disabled, or that never wanted one, keeps none on.

import { and, asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { schedules } from '../db/schema.js';

export interface CleanupWindow {
  scheduleId: string;
  cron: string;
  timeZone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
}

const windowOf = (row: typeof schedules.$inferSelect): CleanupWindow => ({
  scheduleId: row.id,
  cron: row.cron,
  timeZone: row.timeZone,
  enabled: row.enabled,
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
});

/** The project's first cleanup schedule, or null where it has none. */
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
  return row ? windowOf(row) : null;
}
