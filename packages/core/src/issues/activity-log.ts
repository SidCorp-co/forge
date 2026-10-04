import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { activityLog } from '../db/schema.js';
import { ACTIVITY_ROW_COLUMNS, type ActivityRow } from './activity-read.js';

/** One row of an issue's activity, in the caller's transaction when it passes one. */
export async function insertActivityRow(
  values: typeof activityLog.$inferInsert,
  tx: Tx = db,
): Promise<void> {
  await tx.insert(activityLog).values(values);
}

/** Replaces an activity row's payload; answers the row, or null when it is gone. */
export async function setActivityPayload(
  activityId: string,
  payload: Record<string, unknown>,
): Promise<ActivityRow | null> {
  const [updated] = await db
    .update(activityLog)
    .set({ payload })
    .where(eq(activityLog.id, activityId))
    .returning({ ...ACTIVITY_ROW_COLUMNS });
  return (updated as ActivityRow | undefined) ?? null;
}

/** Removes one activity row. */
export async function deleteActivity(activityId: string): Promise<void> {
  await db.delete(activityLog).where(eq(activityLog.id, activityId));
}
