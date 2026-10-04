import type { Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';

/**
 * The one insert into `jobs`, inside the caller's transaction. A unique violation on the active
 * job of an issue and type reaches the caller as the database raised it.
 */
export async function insertJobRow(
  tx: Tx,
  values: typeof jobs.$inferInsert,
): Promise<{ id: string }> {
  const [row] = await tx.insert(jobs).values(values).returning({ id: jobs.id });
  if (!row) throw new Error('jobs: insert returned no row');
  return row;
}
