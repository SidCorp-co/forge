import { db, type Tx } from '../db/client.js';
import { activityLog } from '../db/schema.js';

/** One row of an issue's activity, in the caller's transaction when it passes one. */
export async function insertActivityRow(
  values: typeof activityLog.$inferInsert,
  tx: Tx = db,
): Promise<void> {
  await tx.insert(activityLog).values(values);
}
