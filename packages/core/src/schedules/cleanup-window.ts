// A project's cleanup window (REQ-79 BC-7): its `cleanup` schedule, an ordinary schedule a person
// re-times like any other. The first time a project delivering fast has something to clean and no
// cleanup schedule at all, the default window is saved for it: end of day, owned by the project's
// creator, as the release sweep acts. A project whose cleanup schedule a person disabled keeps it
// disabled: only a project with none is given one.

import { CLEANUP_WINDOW_DEFAULT } from '@forge/contracts/cleanup';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { schedules } from '../db/schema.js';
import { nextRunFor } from './cron.js';
import { loadCreatedBy } from './release-batch-dispatch.js';

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

/** The project's cleanup window, saved at the default where it has none; null with no owner to run as. */
export async function ensureCleanupWindow(projectId: string): Promise<CleanupWindow | null> {
  const held = await readCleanupWindow(projectId);
  if (held) return held;
  const owner = await loadCreatedBy(projectId);
  if (!owner) return null;
  return db.transaction(async (tx) => {
    // two writers seeing none at once save one window between them
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cleanup-window:${projectId}`}))`);
    return (await readCleanupWindow(projectId, tx)) ?? (await saveDefault(tx, projectId, owner));
  });
}

async function saveDefault(tx: Tx, projectId: string, owner: string): Promise<CleanupWindow | null> {
  const { cron, timeZone, name } = CLEANUP_WINDOW_DEFAULT;
  const [row] = await tx
    .insert(schedules)
    .values({
      projectId,
      name,
      cron,
      kind: 'cleanup',
      enabled: true,
      nextRunAt: nextRunFor(cron, new Date(), timeZone),
      timeZone,
      ownerId: owner,
    })
    .returning();
  return row ? windowOf(row) : null;
}
